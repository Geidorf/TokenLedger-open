//! Minimal JSONC support for the Agent writer (T10.292): comments and
//! trailing commas are blanked out byte-for-byte so offsets stay valid, the
//! cleaned text is parsed with `serde_json`, and changes are written back as
//! small text edits. Comments, whitespace and key order outside the edited
//! values are kept. Anything that cannot be located unambiguously is refused.

use serde::Serialize;
use serde_json::{Map, Value};

const REFUSED: &str = "无法安全定位要修改的位置";

/// `text` with comments and trailing commas replaced by spaces (newlines
/// kept), so every byte offset matches the original. `None` for an
/// unterminated string or block comment.
pub fn blank(text: &str) -> Option<String> {
    blank_with(text, true)
}

/// `text` with only comments blanked; trailing commas stay.
fn uncomment(text: &str) -> Option<String> {
    blank_with(text, false)
}

fn blank_with(text: &str, commas: bool) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = bytes.to_vec();
    let mut pending_comma: Option<usize> = None;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                pending_comma = None;
                i += 1;
                loop {
                    match bytes.get(i)? {
                        b'\\' => i += 2,
                        b'"' => break,
                        _ => i += 1,
                    }
                }
                i += 1;
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    out[i] = b' ';
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                let end = text[i + 2..].find("*/")? + i + 4;
                for byte in &mut out[i..end] {
                    if *byte != b'\n' {
                        *byte = b' ';
                    }
                }
                i = end;
            }
            b',' => {
                pending_comma = Some(i);
                i += 1;
            }
            b'}' | b']' => {
                if let Some(comma) = pending_comma.take() {
                    if commas {
                        out[comma] = b' ';
                    }
                }
                i += 1;
            }
            byte if byte.is_ascii_whitespace() => i += 1,
            _ => {
                pending_comma = None;
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Parses JSONC into the top-level object; `None` if it is not one.
pub fn parse(text: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(&blank(text)?) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

struct Member {
    key: String,
    key_start: usize,
    value_start: usize,
    value_end: usize,
    object: Option<Object>,
}

struct Object {
    open: usize,
    close: usize,
    members: Vec<Member>,
}

/// Locates object members in blanked (strict) JSON text.
struct Scanner<'a> {
    text: &'a str,
    pos: usize,
}

impl Scanner<'_> {
    fn skip_ws(&mut self) {
        let bytes = self.text.as_bytes();
        while self.pos < bytes.len() && bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }

    fn expect(&mut self, byte: u8) -> Option<()> {
        self.skip_ws();
        (self.peek()? == byte).then(|| self.pos += 1)
    }

    fn string(&mut self) -> Option<String> {
        let start = self.pos;
        let bytes = self.text.as_bytes();
        self.pos += 1;
        loop {
            match bytes.get(self.pos)? {
                b'\\' => self.pos += 2,
                b'"' => break,
                _ => self.pos += 1,
            }
        }
        self.pos += 1;
        serde_json::from_str(&self.text[start..self.pos]).ok()
    }

    /// Skips one value, returning its object layout when it is an object.
    fn value(&mut self) -> Option<Option<Object>> {
        self.skip_ws();
        match self.peek()? {
            b'{' => self.object().map(Some),
            b'[' => {
                self.pos += 1;
                self.skip_ws();
                if self.peek()? == b']' {
                    self.pos += 1;
                    return Some(None);
                }
                loop {
                    self.value()?;
                    self.skip_ws();
                    match self.peek()? {
                        b',' => self.pos += 1,
                        b']' => {
                            self.pos += 1;
                            return Some(None);
                        }
                        _ => return None,
                    }
                }
            }
            b'"' => self.string().map(|_| None),
            _ => {
                let bytes = self.text.as_bytes();
                let start = self.pos;
                while self.pos < bytes.len()
                    && !matches!(bytes[self.pos], b',' | b'}' | b']')
                    && !bytes[self.pos].is_ascii_whitespace()
                {
                    self.pos += 1;
                }
                (self.pos > start).then_some(None)
            }
        }
    }

    fn object(&mut self) -> Option<Object> {
        self.skip_ws();
        let open = self.pos;
        self.expect(b'{')?;
        let mut members = Vec::new();
        self.skip_ws();
        if self.peek()? == b'}' {
            self.pos += 1;
            return Some(Object {
                open,
                close: self.pos - 1,
                members,
            });
        }
        loop {
            self.skip_ws();
            if self.peek()? != b'"' {
                return None;
            }
            let key_start = self.pos;
            let key = self.string()?;
            self.expect(b':')?;
            self.skip_ws();
            let value_start = self.pos;
            let object = self.value()?;
            members.push(Member {
                key,
                key_start,
                value_start,
                value_end: self.pos,
                object,
            });
            self.skip_ws();
            match self.peek()? {
                b',' => self.pos += 1,
                b'}' => {
                    self.pos += 1;
                    return Some(Object {
                        open,
                        close: self.pos - 1,
                        members,
                    });
                }
                _ => return None,
            }
        }
    }
}

struct Edit {
    start: usize,
    end: usize,
    text: String,
}

struct Patcher<'a> {
    original: &'a str,
    blanked: &'a str,
    uncommented: &'a str,
    unit: String,
    edits: Vec<Edit>,
}

fn line_indent(text: &str, pos: usize) -> &str {
    let start = text[..pos].rfind('\n').map_or(0, |index| index + 1);
    let line = &text[start..];
    &line[..line.len() - line.trim_start_matches([' ', '\t']).len()]
}

/// The file's indent step: a tab, or the smallest leading run of spaces.
fn indent_unit(text: &str) -> String {
    if text.lines().any(|line| line.starts_with('\t')) {
        return "\t".to_string();
    }
    let width = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start_matches(' ').len())
        .filter(|width| *width > 0)
        .min()
        .unwrap_or(2)
        .min(8);
    " ".repeat(width)
}

impl Patcher<'_> {
    fn render(&self, value: &Value, indent: &str) -> Result<String, String> {
        let mut out = Vec::new();
        let formatter = serde_json::ser::PrettyFormatter::with_indent(self.unit.as_bytes());
        let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
        value
            .serialize(&mut serializer)
            .map_err(|error| error.to_string())?;
        let text = String::from_utf8(out).map_err(|error| error.to_string())?;
        Ok(text.replace('\n', &format!("\n{indent}")))
    }

    /// The first member's indent when it starts its own line, else one step
    /// deeper than the line holding `{`.
    fn member_indent(&self, object: &Object) -> String {
        if let Some(first) = object.members.first() {
            let line_start = self.original[..first.key_start]
                .rfind('\n')
                .map_or(0, |index| index + 1);
            let indent = line_indent(self.original, first.key_start);
            if line_start + indent.len() == first.key_start {
                return indent.to_string();
            }
        }
        format!("{}{}", line_indent(self.original, object.open), self.unit)
    }

    /// Where a member's text starts: its line when the key leads the line.
    fn member_start(&self, member: &Member) -> usize {
        let line_start = self.original[..member.key_start]
            .rfind('\n')
            .map_or(0, |index| index + 1);
        if line_start + line_indent(self.original, member.key_start).len() == member.key_start {
            line_start
        } else {
            member.key_start
        }
    }

    /// Deletes the members missing from `after`, one edit per run of adjacent
    /// members. Runs that would swallow a comment are refused.
    fn remove(
        &mut self,
        object: &Object,
        before: &Map<String, Value>,
        after: &Map<String, Value>,
    ) -> Result<(), String> {
        if !before.keys().any(|key| !after.contains_key(key)) {
            return Ok(());
        }
        let gone: Vec<bool> = object
            .members
            .iter()
            .map(|member| !after.contains_key(&member.key))
            .collect();
        let last = object.members.len() - 1;
        let mut index = 0;
        while index <= last {
            if !gone[index] {
                index += 1;
                continue;
            }
            let first = index;
            while index < last && gone[index + 1] {
                index += 1;
            }
            let span = if first == 0 && index == last {
                object.open + 1..object.close
            } else if index < last {
                self.member_start(&object.members[first])
                    ..self.member_start(&object.members[index + 1])
            } else {
                // The tail run: drop the comma ending the previous member
                // (comments after it stay) unless the run carries its own
                // trailing comma, which then goes with it.
                let start = match self.member_start(&object.members[first]) {
                    line_start if line_start != object.members[first].key_start => line_start - 1,
                    key_start => key_start,
                };
                let end = object.members[index].value_end;
                match self.comma_at(end) {
                    Some(comma) => start..comma + 1,
                    None if self.trailing_commas() => start..end,
                    None => {
                        let comma = self
                            .comma_at(object.members[first - 1].value_end)
                            .ok_or_else(|| REFUSED.to_string())?;
                        self.edits.push(Edit {
                            start: comma,
                            end: comma + 1,
                            text: String::new(),
                        });
                        start..end
                    }
                }
            };
            if self.original[span.clone()] != self.uncommented[span.clone()] {
                return Err(REFUSED.to_string());
            }
            self.edits.push(Edit {
                start: span.start,
                end: span.end,
                text: String::new(),
            });
            index += 1;
        }
        Ok(())
    }

    /// Whether the file already ends some object or array with a comma, so a
    /// member left last may keep its own.
    fn trailing_commas(&self) -> bool {
        let bytes = self.uncommented.as_bytes();
        bytes.iter().enumerate().any(|(index, byte)| {
            *byte == b','
                && self.uncommented[index + 1..]
                    .trim_start()
                    .starts_with(['}', ']'])
        })
    }

    /// The comma that is the next token after `pos`, skipping comments.
    fn comma_at(&self, pos: usize) -> Option<usize> {
        let rest = &self.uncommented[pos..];
        let at = pos + rest.len() - rest.trim_start().len();
        (self.uncommented.as_bytes().get(at) == Some(&b',')).then_some(at)
    }

    /// Whether the first token after `pos`, skipping whitespace and comments,
    /// is a comma.
    fn comma_follows(&self, mut pos: usize) -> bool {
        let text = self.original;
        loop {
            let rest = &text[pos..];
            let trimmed = rest.trim_start();
            pos += rest.len() - trimmed.len();
            if trimmed.starts_with("//") {
                pos += trimmed.find('\n').unwrap_or(trimmed.len());
            } else if let Some(body) = trimmed.strip_prefix("/*") {
                match body.find("*/") {
                    Some(end) => pos += end + 4,
                    None => return false,
                }
            } else {
                return trimmed.starts_with(',');
            }
        }
    }

    fn diff(
        &mut self,
        object: &Object,
        before: &Map<String, Value>,
        after: &Map<String, Value>,
    ) -> Result<(), String> {
        self.remove(object, before, after)?;
        let mut added = Vec::new();
        for (key, new) in after {
            let Some(old) = before.get(key) else {
                added.push((key, new));
                continue;
            };
            if old == new {
                continue;
            }
            let mut found = object.members.iter().filter(|member| &member.key == key);
            let (Some(member), None) = (found.next(), found.next()) else {
                return Err(REFUSED.to_string());
            };
            match (old, new, &member.object) {
                (Value::Object(old), Value::Object(new), Some(child)) => {
                    self.diff(child, old, new)?;
                }
                _ => {
                    let span = member.value_start..member.value_end;
                    if self.original[span.clone()] != self.blanked[span.clone()] {
                        return Err(REFUSED.to_string());
                    }
                    let indent = line_indent(self.original, member.value_start).to_string();
                    self.edits.push(Edit {
                        start: span.start,
                        end: span.end,
                        text: self.render(new, &indent)?,
                    });
                }
            }
        }
        if added.is_empty() {
            return Ok(());
        }
        let indent = self.member_indent(object);
        let closing = line_indent(self.original, object.close).to_string();
        let mut text = String::new();
        for (index, (key, value)) in added.iter().enumerate() {
            if index > 0 {
                text.push(',');
            }
            let key = serde_json::to_string(key).map_err(|error| error.to_string())?;
            text.push_str(&format!(
                "\n{indent}{key}: {}",
                self.render(value, &indent)?
            ));
        }
        // After the last member (and any comment trailing it), before `}`.
        let inner = &self.original[object.open + 1..object.close];
        let at = object.open + 1 + inner.trim_end().len();
        if !self.original[at..object.close].contains('\n') {
            text.push('\n');
            text.push_str(&closing);
        }
        if let Some(last) = object.members.last() {
            if !self.comma_follows(last.value_end) {
                if last.value_end == at {
                    text.insert(0, ',');
                } else {
                    self.edits.push(Edit {
                        start: last.value_end,
                        end: last.value_end,
                        text: ",".to_string(),
                    });
                }
            }
        }
        self.edits.push(Edit {
            start: at,
            end: at,
            text,
        });
        Ok(())
    }
}

/// Rewrites `original` so it parses to `after`, touching only the values that
/// differ from `before` (the parse of `original`). Duplicate keys, replaced
/// values containing comments, and removals that would drop a comment are
/// refused.
pub fn patch(original: &str, after: &Map<String, Value>) -> Result<String, String> {
    let blanked = blank(original).ok_or_else(|| REFUSED.to_string())?;
    let uncommented = uncomment(original).ok_or_else(|| REFUSED.to_string())?;
    let before = parse(original).ok_or_else(|| REFUSED.to_string())?;
    let mut scanner = Scanner {
        text: &blanked,
        pos: 0,
    };
    let root = scanner.object().ok_or_else(|| REFUSED.to_string())?;
    let mut patcher = Patcher {
        original,
        blanked: &blanked,
        uncommented: &uncommented,
        unit: indent_unit(original),
        edits: Vec::new(),
    };
    patcher.diff(&root, &before, after)?;
    let mut edits = patcher.edits;
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.start));
    if edits.windows(2).any(|pair| pair[1].end > pair[0].start) {
        return Err(REFUSED.to_string());
    }
    let mut out = original.to_string();
    for edit in edits {
        out.replace_range(edit.start..edit.end, &edit.text);
    }
    if parse(&out).as_ref() != Some(after) {
        return Err(REFUSED.to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn map(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("not an object"),
        }
    }

    fn apply(original: &str, edit: impl FnOnce(&mut Map<String, Value>)) -> Result<String, String> {
        let mut after = parse(original).unwrap();
        edit(&mut after);
        patch(original, &after)
    }

    #[test]
    fn blank_keeps_offsets_and_strings() {
        let text = "{ // a \"quoted\" note\n \"u\": \"http://x/*y*/\", /* b\n c */ \"z\": [1,],\n}";
        let blanked = blank(text).unwrap();
        assert_eq!(blanked.len(), text.len());
        assert_eq!(blanked.lines().count(), text.lines().count());
        assert!(blanked.contains("\"http://x/*y*/\""));
        assert_eq!(
            serde_json::from_str::<Value>(&blanked).unwrap(),
            json!({"u": "http://x/*y*/", "z": [1]})
        );
        assert!(blank("{ /* open").is_none());
        assert!(blank("{ \"open").is_none());
    }

    #[test]
    fn replaces_values_and_keeps_comments_and_order() {
        let original = "// Zed settings\n{\n  // theme\n  \"theme\": \"One Dark\",\n  \"agent\": {\n    \"default_model\": { \"provider\": \"anthropic\", \"model\": \"claude\" }, // pick\n  },\n}\n";
        let out = apply(original, |doc| {
            let model = doc["agent"]["default_model"].as_object_mut().unwrap();
            model.insert("provider".into(), json!("tokenledger"));
            model.insert("model".into(), json!("group/coding"));
        })
        .unwrap();
        assert_eq!(
            out,
            original
                .replace("\"anthropic\"", "\"tokenledger\"")
                .replace("\"claude\"", "\"group/coding\"")
        );
    }

    #[test]
    fn inserts_new_keys_before_the_closing_brace() {
        let original = "{\n  \"a\": 1 // keep\n}\n";
        let out = apply(original, |doc| {
            doc.insert("lm".into(), json!({"x": {"api_url": "u"}}));
        })
        .unwrap();
        assert_eq!(
            out,
            "{\n  \"a\": 1, // keep\n  \"lm\": {\n    \"x\": {\n      \"api_url\": \"u\"\n    }\n  }\n}\n"
        );

        let trailing = "{\n\t\"a\": 1, /* c */\n}";
        let out = apply(trailing, |doc| {
            doc.insert("b".into(), json!(2));
        })
        .unwrap();
        assert_eq!(out, "{\n\t\"a\": 1, /* c */\n\t\"b\": 2\n}");

        let empty = "{ // only a comment\n}";
        let out = apply(empty, |doc| {
            doc.insert("b".into(), json!([1]));
        })
        .unwrap();
        assert_eq!(out, "{ // only a comment\n  \"b\": [\n    1\n  ]\n}");

        let inline = "{\"a\": {}}";
        let out = apply(inline, |doc| {
            doc["a"]
                .as_object_mut()
                .unwrap()
                .insert("b".into(), json!(1));
        })
        .unwrap();
        assert_eq!(parse(&out).unwrap(), map(json!({"a": {"b": 1}})));
    }

    #[test]
    fn removes_members_and_keeps_the_comments_around_them() {
        let original = "{\n  // models\n  \"agents\": {\n    \"mine\": { \"model\": \"x\" }, // ours\n    \"a\": { \"model\": \"t/1\" },\n    \"b\": { \"model\": \"t/1\" }\n  },\n  \"keep\": true,\n}\n";
        let tail = apply(original, |doc| {
            let agents = doc["agents"].as_object_mut().unwrap();
            agents.remove("a");
            agents.remove("b");
        })
        .unwrap();
        assert_eq!(
            tail,
            "{\n  // models\n  \"agents\": {\n    \"mine\": { \"model\": \"x\" }, // ours\n  },\n  \"keep\": true,\n}\n"
        );

        let middle = apply(original, |doc| {
            doc["agents"].as_object_mut().unwrap().remove("a");
        })
        .unwrap();
        assert!(middle.contains("// ours\n    \"b\""));
        assert!(!middle.contains("\"a\""));

        let all = apply(
            "{ \"x\": 1, /* c */ \"o\": { \"a\": 1, \"b\": 2 } }",
            |doc| {
                doc.insert("o".into(), json!({}));
            },
        )
        .unwrap();
        assert_eq!(all, "{ \"x\": 1, /* c */ \"o\": {} }");

        let created = apply("{ // c\n  \"x\": 1,\n  \"o\": { \"a\": 1 }\n}", |doc| {
            doc.remove("o");
        })
        .unwrap();
        assert_eq!(created, "{ // c\n  \"x\": 1\n}");
    }

    #[test]
    fn refuses_what_it_cannot_locate_safely() {
        let duplicate = "{ \"a\": 1, \"a\": 2 }";
        assert!(apply(duplicate, |doc| {
            doc.insert("a".into(), json!(3));
        })
        .is_err());

        let commented = "{ \"a\": [1, /* two */ 2] }";
        assert!(apply(commented, |doc| {
            doc.insert("a".into(), json!([3]));
        })
        .is_err());

        let removed = "{ \"a\": 1, \"b\": [1, /* two */ 2] }";
        assert!(apply(removed, |doc| {
            doc.remove("b");
        })
        .is_err());

        assert!(patch("[1]", &Map::new()).is_err());
    }
}
