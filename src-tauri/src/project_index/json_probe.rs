//! Bounded, whitelist-only reading of JSON / JSONL source headers.
//!
//! Callers name the exact key paths they need (for example `["cwd"]` or
//! `["payload", "cwd"]`). Every other value — prompts, replies, tool output,
//! titles, branches — is consumed with `IgnoredAny` straight from the reader:
//! it is never collected into a `String` or `Value`. Reading stops as soon as
//! all wanted fields of a value are found, when the caller has what it needs,
//! or when the byte budget runs out.

use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use std::cell::Cell;
use std::fmt;
use std::io::{self, BufRead, Read};

/// A wanted string longer than this is treated as absent (no real working
/// directory is this long) and is not kept.
pub(crate) const MAX_FIELD_BYTES: usize = 8 * 1024;

const EARLY_EXIT: &str = "tokenledger-project-index-fields-complete";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProbeError {
    /// The byte budget ran out before the caller was satisfied.
    BudgetExceeded,
    /// The input is not JSON where a value was expected, or is truncated.
    Malformed,
    Io,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Flow {
    Stop,
    Continue,
}

/// JSON Lines: hands the whitelisted fields of each line to `on_value`,
/// index-aligned with `paths` (non-string leaves are `None`). Blank lines are
/// skipped; a malformed or truncated line is skipped like the scanners do.
///
/// Returns `Ok(())` when `on_value` stops, at end of input or after
/// `max_lines`; errors only describe *why* reading ended early so the caller
/// can pick a reason code. When the budget runs out mid-line, fields already
/// read in full on that line are still reported before the error.
pub(crate) fn probe_lines<R: BufRead>(
    mut reader: R,
    paths: &[&[&str]],
    max_lines: usize,
    max_bytes: u64,
    mut on_value: impl FnMut(&[Option<String>]) -> Flow,
) -> Result<(), ProbeError> {
    skip_bom(&mut reader);
    let budget = Budget::new(max_bytes);
    for _ in 0..max_lines {
        if !skip_whitespace(&mut reader, &budget)? {
            return Ok(());
        }
        let mut line = LineReader {
            inner: &mut reader,
            budget: &budget,
            done: false,
        };
        let (found, outcome) = probe_one(&mut line, paths, &budget);
        match outcome {
            Outcome::Complete | Outcome::EarlyExit => {
                if on_value(&found) == Flow::Stop {
                    return Ok(());
                }
            }
            Outcome::Truncated | Outcome::Failed(ProbeError::Malformed) => {}
            Outcome::Failed(ProbeError::BudgetExceeded) => {
                if found.iter().any(Option::is_some) {
                    on_value(&found);
                }
                return Err(ProbeError::BudgetExceeded);
            }
            Outcome::Failed(ProbeError::Io) => return Err(ProbeError::Io),
        }
        line.drain()?;
    }
    Ok(())
}

/// One JSON document (possibly pretty-printed). Returns the wanted fields
/// found — including those read in full before an error — and why reading
/// ended, if it ended early.
pub(crate) fn probe_document<R: BufRead>(
    mut reader: R,
    paths: &[&[&str]],
    max_bytes: u64,
) -> (Vec<Option<String>>, Result<(), ProbeError>) {
    skip_bom(&mut reader);
    let budget = Budget::new(max_bytes);
    let bounded = Bounded {
        inner: reader,
        budget: &budget,
    };
    let (found, outcome) = probe_one(bounded, paths, &budget);
    let result = match outcome {
        Outcome::Complete | Outcome::EarlyExit => Ok(()),
        Outcome::Truncated => Err(ProbeError::Malformed),
        Outcome::Failed(error) => Err(error),
    };
    (found, result)
}

/// Reads a small whole-file text value (for example Gemini `.project_root`),
/// capped at `max_bytes`; invalid UTF-8 is replaced, never rejected.
pub(crate) fn read_small_text(path: &std::path::Path, max_bytes: u64) -> io::Result<String> {
    let file = std::fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(max_bytes).read_to_end(&mut bytes)?;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes.drain(..3);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

enum Outcome {
    Complete,
    EarlyExit,
    /// Input ended inside the value.
    Truncated,
    Failed(ProbeError),
}

fn probe_one<R: Read>(
    reader: R,
    paths: &[&[&str]],
    budget: &Budget,
) -> (Vec<Option<String>>, Outcome) {
    let mut collector = Collector {
        paths,
        found: vec![None; paths.len()],
        missing: paths.len(),
    };
    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    let root = Node {
        collector: &mut collector,
        depth: 0,
        active: (0..paths.len()).collect(),
    };
    let outcome = match root.deserialize(&mut deserializer) {
        Ok(()) => Outcome::Complete,
        Err(error) if error.is_data() && error.to_string().contains(EARLY_EXIT) => {
            Outcome::EarlyExit
        }
        Err(_) if budget.exhausted.get() => Outcome::Failed(ProbeError::BudgetExceeded),
        Err(error) => match error.classify() {
            serde_json::error::Category::Eof => Outcome::Truncated,
            serde_json::error::Category::Io => Outcome::Failed(ProbeError::Io),
            _ => Outcome::Failed(ProbeError::Malformed),
        },
    };
    (collector.found, outcome)
}

fn skip_bom<R: BufRead>(reader: &mut R) {
    if let Ok(head) = reader.fill_buf() {
        if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
            reader.consume(3);
        }
    }
}

/// Skips whitespace between values; `false` at end of input.
fn skip_whitespace<R: BufRead>(reader: &mut R, budget: &Budget) -> Result<bool, ProbeError> {
    loop {
        let available = reader.fill_buf().map_err(|_| ProbeError::Io)?;
        if available.is_empty() {
            return Ok(false);
        }
        let blank = available
            .iter()
            .take_while(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
            .count();
        if blank == 0 {
            return Ok(true);
        }
        let allowed = budget.allowance(blank);
        if allowed == 0 {
            return Err(ProbeError::BudgetExceeded);
        }
        reader.consume(allowed);
        budget.spend(allowed);
    }
}

/// Byte budget shared by every read of one probe call.
struct Budget {
    remaining: Cell<u64>,
    exhausted: Cell<bool>,
}

impl Budget {
    fn new(max_bytes: u64) -> Self {
        Self {
            remaining: Cell::new(max_bytes),
            exhausted: Cell::new(false),
        }
    }

    /// How many of `wanted` bytes may still be read.
    fn allowance(&self, wanted: usize) -> usize {
        let remaining = self.remaining.get();
        if remaining == 0 && wanted > 0 {
            self.exhausted.set(true);
            return 0;
        }
        wanted.min(usize::try_from(remaining).unwrap_or(usize::MAX))
    }

    fn spend(&self, used: usize) {
        self.remaining
            .set(self.remaining.get().saturating_sub(used as u64));
    }
}

/// Document mode: refuses to read past the budget.
struct Bounded<'b, R> {
    inner: R,
    budget: &'b Budget,
}

impl<R: Read> Read for Bounded<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let allowed = self.budget.allowance(buf.len());
        if allowed == 0 {
            return Ok(0);
        }
        let read = self.inner.read(&mut buf[..allowed])?;
        self.budget.spend(read);
        Ok(read)
    }
}

/// Line mode: yields bytes up to and including the next `\n`, then reports
/// end of input, so one bad line can never swallow the next.
struct LineReader<'r, 'b, R> {
    inner: &'r mut R,
    budget: &'b Budget,
    done: bool,
}

impl<R: BufRead> LineReader<'_, '_, R> {
    /// Skips the rest of the current line without keeping any of it.
    fn drain(&mut self) -> Result<(), ProbeError> {
        while !self.done {
            let available = self.inner.fill_buf().map_err(|_| ProbeError::Io)?;
            if available.is_empty() {
                self.done = true;
                break;
            }
            let limit = self.budget.allowance(available.len());
            if limit == 0 {
                return Err(ProbeError::BudgetExceeded);
            }
            let (used, newline) = match available[..limit].iter().position(|byte| *byte == b'\n') {
                Some(index) => (index + 1, true),
                None => (limit, false),
            };
            self.inner.consume(used);
            self.budget.spend(used);
            self.done = newline;
        }
        Ok(())
    }
}

impl<R: BufRead> Read for LineReader<'_, '_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.done || buf.is_empty() {
            return Ok(0);
        }
        let available = self.inner.fill_buf()?;
        if available.is_empty() {
            self.done = true;
            return Ok(0);
        }
        let limit = self.budget.allowance(available.len().min(buf.len()));
        if limit == 0 {
            return Ok(0);
        }
        let (used, newline) = match available[..limit].iter().position(|byte| *byte == b'\n') {
            Some(index) => (index + 1, true),
            None => (limit, false),
        };
        buf[..used].copy_from_slice(&available[..used]);
        self.inner.consume(used);
        self.budget.spend(used);
        self.done = newline;
        Ok(used)
    }
}

struct Collector<'p> {
    paths: &'p [&'p [&'p str]],
    found: Vec<Option<String>>,
    missing: usize,
}

struct Node<'c, 'p> {
    collector: &'c mut Collector<'p>,
    depth: usize,
    /// Indices of wanted paths whose prefix matches the keys seen so far.
    active: Vec<usize>,
}

impl<'de> DeserializeSeed<'de> for Node<'_, '_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Node<'_, '_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let Node {
            collector,
            depth,
            active,
        } = self;
        while let Some(key) = map.next_key::<String>()? {
            let mut leaves = Vec::new();
            let mut deeper = Vec::new();
            for &index in &active {
                let path = collector.paths[index];
                if path.get(depth) == Some(&key.as_str()) {
                    if path.len() == depth + 1 {
                        leaves.push(index);
                    } else {
                        deeper.push(index);
                    }
                }
            }
            if !deeper.is_empty() {
                map.next_value_seed(Node {
                    collector: &mut *collector,
                    depth: depth + 1,
                    active: deeper,
                })?;
            } else if !leaves.is_empty() {
                let value = map.next_value_seed(LeafString)?;
                for index in leaves {
                    if collector.found[index].is_none() && value.is_some() {
                        collector.found[index] = value.clone();
                        collector.missing -= 1;
                    }
                }
            } else {
                map.next_value::<IgnoredAny>()?;
            }
            if collector.missing == 0 {
                return Err(de::Error::custom(EARLY_EXIT));
            }
        }
        Ok(())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(())
    }

    fn visit_bool<E: de::Error>(self, _value: bool) -> Result<(), E> {
        Ok(())
    }

    fn visit_i64<E: de::Error>(self, _value: i64) -> Result<(), E> {
        Ok(())
    }

    fn visit_u64<E: de::Error>(self, _value: u64) -> Result<(), E> {
        Ok(())
    }

    fn visit_f64<E: de::Error>(self, _value: f64) -> Result<(), E> {
        Ok(())
    }

    fn visit_str<E: de::Error>(self, _value: &str) -> Result<(), E> {
        Ok(())
    }

    fn visit_unit<E: de::Error>(self) -> Result<(), E> {
        Ok(())
    }
}

/// A wanted leaf: kept only when it is a string of reasonable size.
struct LeafString;

impl<'de> DeserializeSeed<'de> for LeafString {
    type Value = Option<String>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for LeafString {
    type Value = Option<String>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a string")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok((value.len() <= MAX_FIELD_BYTES).then(|| value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
        Ok((value.len() <= MAX_FIELD_BYTES).then_some(value))
    }

    fn visit_bool<E: de::Error>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_i64<E: de::Error>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_u64<E: de::Error>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_f64<E: de::Error>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(None)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn lines(input: &str, paths: &[&[&str]], max: usize, budget: u64) -> Vec<Vec<Option<String>>> {
        let mut out = Vec::new();
        let _ = probe_lines(
            Cursor::new(input.as_bytes()),
            paths,
            max,
            budget,
            |fields| {
                out.push(fields.to_vec());
                Flow::Continue
            },
        );
        out
    }

    #[test]
    fn reads_only_whitelisted_fields_per_line() {
        let input = concat!(
            "{\"message\":{\"content\":\"secret prompt\"},\"cwd\":\"/w/app\"}\n",
            "\n",
            "{\"cwd\":\"/w/other\",\"extra\":[1,2,{\"cwd\":\"nested\"}]}\n"
        );
        let got = lines(input, &[&["cwd"]], 10, 1 << 20);
        assert_eq!(
            got,
            vec![vec![Some("/w/app".into())], vec![Some("/w/other".into())]]
        );
    }

    #[test]
    fn nested_paths_and_non_string_leaves() {
        let input = "{\"type\":\"session_meta\",\"payload\":{\"cwd\":7,\"id\":\"x\"}}\n";
        let got = lines(input, &[&["type"], &["payload", "cwd"]], 1, 1 << 20);
        assert_eq!(got, vec![vec![Some("session_meta".into()), None]]);
    }

    #[test]
    fn malformed_line_is_skipped_and_next_line_still_read() {
        let input = "{\"cwd\": oops\n{\"cwd\":\"/w/ok\"}\n";
        let got = lines(input, &[&["cwd"]], 10, 1 << 20);
        assert_eq!(got, vec![vec![Some("/w/ok".into())]]);
    }

    #[test]
    fn truncated_last_line_is_ignored() {
        let got = lines(
            "{\"cwd\":\"/w/a\"}\n{\"cwd\":\"/w/b",
            &[&["cwd"]],
            10,
            1 << 20,
        );
        assert_eq!(got, vec![vec![Some("/w/a".into())]]);
    }

    #[test]
    fn budget_stops_reading_and_reports_fields_already_read() {
        let long = "x".repeat(4096);
        let input = format!("{{\"cwd\":\"/w/a\",\"message\":\"{long}\",\"type\":\"user\"}}\n");
        let mut seen = Vec::new();
        let result = probe_lines(
            Cursor::new(input.as_bytes()),
            &[&["cwd"], &["type"]],
            4,
            256,
            |fields| {
                seen.push(fields.to_vec());
                Flow::Continue
            },
        );
        assert_eq!(result, Err(ProbeError::BudgetExceeded));
        assert_eq!(seen, vec![vec![Some("/w/a".into()), None]]);
    }

    #[test]
    fn stops_early_once_all_fields_are_found() {
        // The value after `cwd` is not even valid JSON: it is never parsed.
        let input = "{\"cwd\":\"/w/a\",\"message\": <<<not json>>> }\n";
        let got = lines(input, &[&["cwd"]], 1, 1 << 20);
        assert_eq!(got, vec![vec![Some("/w/a".into())]]);
    }

    #[test]
    fn oversized_wanted_string_is_treated_as_absent() {
        let long = "a".repeat(MAX_FIELD_BYTES + 1);
        let input = format!("{{\"cwd\":\"{long}\"}}\n");
        let got = lines(&input, &[&["cwd"]], 1, 1 << 20);
        assert_eq!(got, vec![vec![None]]);
    }

    #[test]
    fn document_mode_handles_pretty_json_and_bom() {
        let input =
            "\u{feff}{\n  \"info\": {\n    \"id\": \"s1\",\n    \"cwd\": \"/w/g\"\n  }\n}\n";
        let (found, result) = probe_document(
            Cursor::new(input.as_bytes()),
            &[&["info", "id"], &["info", "cwd"]],
            1 << 20,
        );
        assert_eq!(result, Ok(()));
        assert_eq!(found, vec![Some("s1".into()), Some("/w/g".into())]);
    }

    #[test]
    fn document_mode_reports_truncation() {
        let (found, result) = probe_document(
            Cursor::new(&b"{\"a\":\"b\",\"cwd\":\"/w"[..]),
            &[&["a"], &["cwd"]],
            1024,
        );
        assert_eq!(result, Err(ProbeError::Malformed));
        assert_eq!(found, vec![Some("b".into()), None]);
    }

    #[test]
    fn crlf_lines_are_supported() {
        let got = lines(
            "{\"cwd\":\"/w/a\"}\r\n{\"cwd\":\"/w/b\"}\r\n",
            &[&["cwd"]],
            10,
            1 << 20,
        );
        assert_eq!(
            got,
            vec![vec![Some("/w/a".into())], vec![Some("/w/b".into())]]
        );
    }
}
