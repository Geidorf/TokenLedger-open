//! Bounded line reading shared by the JSONL usage parsers.
//!
//! `BufRead::lines()` has three failure modes on real transcripts: one invalid
//! UTF-8 byte (a truncated multi-byte character, a mis-encoded tool output)
//! turns the whole line into an error and most parsers then drop the rest of
//! the file; an unterminated or huge line is buffered without limit; and a
//! persistent read error yields `Some(Err(_))` forever, so a parser that
//! `continue`s on errors spins. [`bounded_lines`] keeps the `lines()` shape but
//! decodes lossily, skips lines over a byte cap without buffering them, strips
//! a leading BOM and fuses after the first read error.

use std::fs;
use std::io::{self, BufRead, Read};
use std::path::Path;

/// No usage record comes near this; transcript lines this long are inlined
/// attachments or runaway tool output and carry no token counters.
pub(crate) const MAX_JSONL_LINE_BYTES: usize = 32 * 1024 * 1024;

/// Upper bound for whole-document sources (legacy single-JSON sessions).
pub(crate) const MAX_JSON_DOCUMENT_BYTES: u64 = 256 * 1024 * 1024;

/// Upper bound for small sidecar files (settings, summaries, metadata).
pub(crate) const MAX_SIDECAR_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) struct BoundedLines<R> {
    reader: R,
    max_line_bytes: usize,
    buffer: Vec<u8>,
    first: bool,
    done: bool,
}

/// Drop-in replacement for `reader.lines()`. An oversized line is yielded as
/// an empty string so line numbering (used in some unique keys) stays aligned.
pub(crate) fn bounded_lines<R: BufRead>(reader: R) -> BoundedLines<R> {
    bounded_lines_with_limit(reader, MAX_JSONL_LINE_BYTES)
}

pub(crate) fn bounded_lines_with_limit<R: BufRead>(
    reader: R,
    max_line_bytes: usize,
) -> BoundedLines<R> {
    BoundedLines {
        reader,
        max_line_bytes,
        buffer: Vec::new(),
        first: true,
        done: false,
    }
}

impl<R: BufRead> BoundedLines<R> {
    /// Reads one physical line into `self.buffer`. Returns `Ok(None)` at EOF
    /// and `Ok(Some(oversized))` otherwise.
    fn read_line(&mut self) -> io::Result<Option<bool>> {
        // Don't keep a buffer sized for one huge line alive for the whole file.
        if self.buffer.capacity() > 4 * 1024 * 1024 {
            self.buffer = Vec::new();
        }
        self.buffer.clear();
        let mut consumed_any = false;
        let mut oversized = false;
        loop {
            let available = match self.reader.fill_buf() {
                Ok(available) => available,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            if available.is_empty() {
                return Ok(consumed_any.then_some(oversized));
            }
            consumed_any = true;
            let (count, complete) = match available.iter().position(|byte| *byte == b'\n') {
                Some(index) => (index + 1, true),
                None => (available.len(), false),
            };
            if !oversized {
                let room = self.max_line_bytes.saturating_sub(self.buffer.len());
                let content = if complete { count - 1 } else { count };
                if content > room {
                    oversized = true;
                    self.buffer.clear();
                } else {
                    // Grow geometrically but never past the cap, so the
                    // buffer can't double to twice the limit.
                    let needed = self.buffer.len() + content;
                    if needed > self.buffer.capacity() {
                        let target = (self.buffer.capacity() * 2)
                            .max(needed)
                            .min(self.max_line_bytes);
                        self.buffer.reserve_exact(target - self.buffer.len());
                    }
                    self.buffer.extend_from_slice(&available[..content]);
                }
            }
            self.reader.consume(count);
            if complete {
                return Ok(Some(oversized));
            }
        }
    }
}

impl<R: BufRead> Iterator for BoundedLines<R> {
    type Item = io::Result<String>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        let oversized = match self.read_line() {
            Ok(Some(oversized)) => oversized,
            Ok(None) => {
                self.done = true;
                return None;
            }
            Err(error) => {
                self.done = true;
                return Some(Err(error));
            }
        };
        let first = std::mem::replace(&mut self.first, false);
        if oversized {
            log::warn!(
                "skipping a JSONL line longer than {} bytes",
                self.max_line_bytes
            );
            return Some(Ok(String::new()));
        }
        if self.buffer.last() == Some(&b'\r') {
            self.buffer.pop();
        }
        let mut bytes = self.buffer.as_slice();
        if first {
            bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        }
        // A crash or power loss can leave NUL padding where the OS had
        // reserved blocks; the next append then starts after it.
        while let [0, rest @ ..] = bytes {
            bytes = rest;
        }
        while let [rest @ .., 0] = bytes {
            bytes = rest;
        }
        Some(Ok(String::from_utf8_lossy(bytes).into_owned()))
    }
}

/// `fs::read_to_string` with a size cap and lossy decoding. Larger files are
/// rejected instead of being loaded, a leading BOM is removed.
pub(crate) fn read_text_capped(path: &Path, max_bytes: u64) -> io::Result<String> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} is larger than {max_bytes} bytes", path.display()),
        ));
    }
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    Ok(String::from_utf8_lossy(text).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    fn collect(input: &[u8], limit: usize) -> Vec<String> {
        bounded_lines_with_limit(Cursor::new(input.to_vec()), limit)
            .map(|line| line.expect("in-memory read"))
            .collect()
    }

    #[test]
    fn matches_lines_for_plain_input() {
        let input = "a\nb\r\n\nlast";
        let expected: Vec<String> = Cursor::new(input).lines().map(Result::unwrap).collect();
        assert_eq!(collect(input.as_bytes(), 1024), expected);
        assert!(collect(b"", 1024).is_empty());
        assert_eq!(collect(b"\n", 1024), vec![String::new()]);
    }

    #[test]
    fn keeps_lines_with_invalid_utf8_and_strips_bom() {
        let lines = collect(b"\xEF\xBB\xBF{\"a\":1}\n{\"b\":\"\xFF\xC3\"}\n", 1024);
        assert_eq!(lines[0], "{\"a\":1}");
        assert!(serde_json::from_str::<serde_json::Value>(&lines[1]).is_ok());
        let padded = collect(b"\0\0\0{\"a\":1}\0\0\n\0\0\0\0\n", 1024);
        assert_eq!(padded, vec!["{\"a\":1}", ""]);
    }

    #[test]
    fn oversized_lines_become_empty_without_shifting_numbering() {
        // A tiny BufReader capacity forces the cap to be crossed mid-chunk.
        let input = format!("short\n{}\nafter\n{}", "x".repeat(100), "y".repeat(50));
        let reader = BufReader::with_capacity(7, Cursor::new(input.into_bytes()));
        let lines: Vec<String> = bounded_lines_with_limit(reader, 16)
            .map(Result::unwrap)
            .collect();
        assert_eq!(lines, vec!["short", "", "after", ""]);
    }

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("persistent failure"))
        }
    }

    #[test]
    fn persistent_read_errors_end_the_iteration() {
        let mut lines = bounded_lines(BufReader::new(FailingReader));
        assert!(matches!(lines.next(), Some(Err(_))));
        assert!(lines.next().is_none());
        // Parsers that `continue` on errors therefore terminate as well.
        let skipped = bounded_lines(BufReader::new(FailingReader))
            .filter_map(Result::ok)
            .count();
        assert_eq!(skipped, 0);
    }

    #[test]
    fn capped_text_reads_reject_large_files() {
        let dir =
            std::env::temp_dir().join(format!("tokenledger_jsonl_cap_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.json");
        fs::write(&path, b"\xEF\xBB\xBF{\"k\":\"\xFF\"}").unwrap();
        let text = read_text_capped(&path, 64).unwrap();
        assert!(text.starts_with('{'));
        assert!(read_text_capped(&path, 4).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
