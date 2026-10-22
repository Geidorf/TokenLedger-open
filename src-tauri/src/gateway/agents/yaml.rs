//! A deliberately small YAML editor for Agent configs (T10.291). It only
//! understands block mappings: values on the path being written are replaced
//! in place, missing keys are appended to their parent block, keys can be
//! removed or copied whole from another document (T10.298), and every other
//! line (comments, sequences, ordering) is kept byte for byte. Anything it
//! cannot read safely — tabs, multiple documents, anchors on the edited path,
//! a sequence where a mapping is expected — is refused instead of guessed, so
//! no YAML dependency is needed.

use serde_json::{Map, Value};

const STEP: usize = 2;

pub struct YamlDoc {
    lines: Vec<String>,
}

#[derive(Clone, Copy)]
struct Block {
    start: usize,
    end: usize,
    indent: usize,
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// Blank, comment, or the optional leading `---` (later ones are refused).
fn ignorable(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty() || trimmed.starts_with('#') || trimmed == "---"
}

fn is_sequence_item(trimmed: &str) -> bool {
    trimmed == "-" || trimmed.starts_with("- ")
}

/// End of a quoted scalar starting at byte 0, exclusive.
fn quoted_end(text: &str) -> Option<usize> {
    let quote = text.chars().next()?;
    let mut chars = text.char_indices().skip(1).peekable();
    while let Some((index, ch)) = chars.next() {
        if quote == '"' && ch == '\\' {
            chars.next();
        } else if ch == quote {
            if quote == '\'' && matches!(chars.peek(), Some((_, '\''))) {
                chars.next();
                continue;
            }
            return Some(index + 1);
        }
    }
    None
}

fn unquote(token: &str) -> Option<String> {
    if token.starts_with('"') {
        serde_json::from_str::<String>(token).ok()
    } else if token.starts_with('\'') && token.len() >= 2 && token.ends_with('\'') {
        Some(token[1..token.len() - 1].replace("''", "'"))
    } else {
        None
    }
}

/// `(key, key token length, rest after the colon)` for a `key: value` line.
fn parse_key(trimmed: &str) -> Option<(String, usize, &str)> {
    if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        let end = quoted_end(trimmed)?;
        let rest = trimmed[end..].strip_prefix(':')?;
        if !(rest.is_empty() || rest.starts_with(' ')) {
            return None;
        }
        return Some((unquote(&trimmed[..end])?, end, rest.trim()));
    }
    if trimmed.starts_with(['-', '?', '[', '{', '#', '&', '*', '!', '|', '>', '%', '@']) {
        return None;
    }
    let end = trimmed
        .find(": ")
        .or_else(|| trimmed.ends_with(':').then(|| trimmed.len() - 1))?;
    let key = trimmed[..end].trim_end();
    if key.is_empty() || key.contains(" #") {
        return None;
    }
    Some((key.to_string(), end, trimmed[end + 1..].trim()))
}

/// Splits an inline value from a trailing `# comment` outside quotes.
fn split_comment(rest: &str) -> (&str, Option<&str>) {
    let mut quote = None;
    let mut escaped = false;
    let mut previous = ' ';
    for (index, ch) in rest.char_indices() {
        match quote {
            Some('"') if escaped => escaped = false,
            Some('"') if ch == '\\' => escaped = true,
            Some(open) if ch == open => quote = None,
            Some(_) => {}
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch == '#' && previous.is_whitespace() => {
                return (rest[..index].trim_end(), Some(&rest[index..]));
            }
            None => {}
        }
        previous = ch;
    }
    (rest.trim_end(), None)
}

fn scalar(value: &str) -> Value {
    if value.starts_with('"') || value.starts_with('\'') {
        return unquote(value).map_or_else(|| Value::from(value), Value::from);
    }
    if value.starts_with('{') || value.starts_with('[') {
        return serde_json::from_str(value).unwrap_or_else(|_| Value::from(value));
    }
    match value {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "null" | "~" => Value::Null,
        _ => Value::from(value),
    }
}

fn key_token(key: &str) -> String {
    let plain = key
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric() || first == '_')
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/'));
    if plain {
        key.to_string()
    } else {
        serde_json::to_string(key).unwrap_or_default()
    }
}

/// A YAML scalar or flow collection for `value`. JSON strings are valid
/// double-quoted YAML; collections get `": "`/`", "` separators so YAML 1.1
/// parsers read them too.
pub fn render(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(render).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(key, value)| format!(
                    "{}: {}",
                    serde_json::to_string(key).unwrap_or_default(),
                    render(value)
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        other => other.to_string(),
    }
}

impl YamlDoc {
    pub fn parse(text: &str) -> Result<Self, String> {
        let lines: Vec<String> = text.lines().map(str::to_string).collect();
        let mut seen_content = false;
        for line in &lines {
            let leading: String = line.chars().take_while(|ch| ch.is_whitespace()).collect();
            if leading.contains('\t') && !line.trim().is_empty() {
                return Err("YAML 缩进里有制表符".to_string());
            }
            let trimmed = line.trim_end();
            if trimmed.starts_with('%') || trimmed == "..." {
                return Err("YAML 含指令或文档结束标记".to_string());
            }
            if trimmed.starts_with("---") {
                if seen_content || trimmed != "---" {
                    return Err("YAML 含多个文档或文档标记后带内容".to_string());
                }
                continue;
            }
            seen_content |= !ignorable(line);
        }
        let doc = Self { lines };
        doc.to_map()?;
        Ok(doc)
    }

    pub fn serialize(&self) -> String {
        let mut text = self.lines.join("\n");
        text.push('\n');
        text
    }

    fn root(&self) -> Block {
        let indent = self
            .lines
            .iter()
            .find(|line| !ignorable(line))
            .map_or(0, |line| indent_of(line));
        Block {
            start: 0,
            end: self.lines.len(),
            indent,
        }
    }

    fn content(&self, block: Block) -> impl Iterator<Item = usize> + '_ {
        (block.start..block.end).filter(move |&index| !ignorable(&self.lines[index]))
    }

    /// Lines `[index + 1, end)` holding the value of the key at `index`.
    fn extent(&self, index: usize, key_indent: usize, limit: usize) -> usize {
        let mut last = index;
        for next in index + 1..limit {
            let line = &self.lines[next];
            if ignorable(line) {
                continue;
            }
            let indent = indent_of(line);
            if indent > key_indent || (indent == key_indent && is_sequence_item(line.trim_start()))
            {
                last = next;
            } else {
                break;
            }
        }
        last + 1
    }

    /// The mapping held under the key at `index`, or why it is not one.
    fn child(&self, index: usize, block: Block, key: &str) -> Result<Block, String> {
        let end = self.extent(index, block.indent, block.end);
        let (_, _, rest) = parse_key(self.lines[index].trim_start()).unwrap_or_default();
        let (value, _) = split_comment(rest);
        if !value.is_empty() && value != "{}" {
            return Err(format!(
                "配置里的「{key}」不是块状映射，为安全起见未做改动。"
            ));
        }
        let first = self
            .content(Block {
                start: index + 1,
                end,
                indent: 0,
            })
            .next();
        match first {
            Some(line) if is_sequence_item(self.lines[line].trim_start()) => Err(format!(
                "配置里的「{key}」是列表不是映射，为安全起见未做改动。"
            )),
            Some(line) => Ok(Block {
                start: index + 1,
                end,
                indent: indent_of(&self.lines[line]),
            }),
            None => Ok(Block {
                start: index + 1,
                end,
                indent: block.indent + STEP,
            }),
        }
    }

    fn find(&self, block: Block, key: &str) -> Result<Option<usize>, String> {
        let mut index = block.start;
        while index < block.end {
            let line = &self.lines[index];
            if ignorable(line) {
                index += 1;
                continue;
            }
            if indent_of(line) != block.indent {
                return Err("YAML 缩进不一致，为安全起见未做改动。".to_string());
            }
            let Some((found, _, _)) = parse_key(line.trim_start()) else {
                return Err("YAML 含无法安全解析的写法（如列表或复杂键），未做改动。".to_string());
            };
            if found == key {
                return Ok(Some(index));
            }
            index = self.extent(index, block.indent, block.end);
        }
        Ok(None)
    }

    /// Sets `path` to an already rendered YAML value.
    pub fn set(&mut self, path: &[&str], value: &str) -> Result<(), String> {
        let mut block = self.root();
        for (depth, key) in path.iter().enumerate() {
            let Some(index) = self.find(block, key)? else {
                let at = self.append_at(block);
                let lines = path[depth..].iter().enumerate().map(|(offset, key)| {
                    let pad = " ".repeat(block.indent + offset * STEP);
                    if depth + offset + 1 == path.len() {
                        format!("{pad}{}: {value}", key_token(key))
                    } else {
                        format!("{pad}{}:", key_token(key))
                    }
                });
                self.lines.splice(at..at, lines.collect::<Vec<_>>());
                return Ok(());
            };
            if depth + 1 < path.len() {
                let line = self.lines[index].trim_start().to_string();
                let (_, token_len, rest) = parse_key(&line).unwrap_or_default();
                if split_comment(rest).0 == "{}" {
                    self.lines[index] =
                        format!("{}{}:", " ".repeat(block.indent), &line[..token_len]);
                }
                block = self.child(index, block, key)?;
                continue;
            }
            let end = self.extent(index, block.indent, block.end);
            let line = self.lines[index].trim_start().to_string();
            let (_, token_len, rest) = parse_key(&line).unwrap_or_default();
            if rest.starts_with(['&', '*', '!']) {
                return Err(format!(
                    "配置里的「{key}」带锚点或标签，为安全起见未做改动。"
                ));
            }
            let (_, comment) = split_comment(rest);
            let comment = comment.map(|c| format!(" {c}")).unwrap_or_default();
            self.lines[index] = format!(
                "{}{}: {value}{comment}",
                " ".repeat(block.indent),
                &line[..token_len]
            );
            self.lines.drain(index + 1..end);
            return Ok(());
        }
        Ok(())
    }

    /// Where a new key goes: after the last entry of `block`.
    fn append_at(&self, block: Block) -> usize {
        self.content(block).last().map_or(block.start, |line| {
            self.extent(line, block.indent, block.end)
        })
    }

    /// The key line of `path` with the end of its value, `None` when missing.
    fn locate(&self, path: &[&str]) -> Result<Option<(usize, usize, Block)>, String> {
        let Some((last, parents)) = path.split_last() else {
            return Ok(None);
        };
        let mut block = self.root();
        for key in parents {
            let Some(index) = self.find(block, key)? else {
                return Ok(None);
            };
            block = self.child(index, block, key)?;
        }
        Ok(self
            .find(block, last)?
            .map(|index| (index, self.extent(index, block.indent, block.end), block)))
    }

    /// Lines `[start, end)` may go away only when they define no anchor that
    /// an alias elsewhere could still point at.
    fn ensure_no_anchor(&self, start: usize, end: usize, key: &str) -> Result<(), String> {
        for line in &self.lines[start..end] {
            if ignorable(line) {
                continue;
            }
            let mut trimmed = line.trim_start();
            while let Some(rest) = trimmed.strip_prefix("- ") {
                trimmed = rest.trim_start();
            }
            let value = match parse_key(trimmed) {
                Some((_, _, rest)) => split_comment(rest).0,
                None => split_comment(trimmed).0,
            };
            if value.starts_with('&') {
                return Err(format!("配置里的「{key}」带锚点，为安全起见未做改动。"));
            }
        }
        Ok(())
    }

    /// The lines of `path` (key line, value and comments inside it) with the
    /// key's own indentation removed, `None` when missing.
    pub fn entry(&self, path: &[&str]) -> Result<Option<Vec<String>>, String> {
        let Some((index, end, block)) = self.locate(path)? else {
            return Ok(None);
        };
        Ok(Some(
            self.lines[index..end]
                .iter()
                .map(|line| line[indent_of(line).min(block.indent)..].to_string())
                .collect(),
        ))
    }

    /// The block under `parents`, adding missing keys as empty mappings.
    fn ensure_block(&mut self, parents: &[&str]) -> Result<Block, String> {
        let mut block = self.root();
        for key in parents {
            let index = match self.find(block, key)? {
                Some(index) => index,
                None => {
                    let at = self.append_at(block);
                    let pad = " ".repeat(block.indent);
                    self.lines.insert(at, format!("{pad}{}:", key_token(key)));
                    block.end += 1;
                    at
                }
            };
            let line = self.lines[index].trim_start().to_string();
            let (_, token_len, rest) = parse_key(&line).unwrap_or_default();
            if split_comment(rest).0 == "{}" {
                self.lines[index] = format!("{}{}:", " ".repeat(block.indent), &line[..token_len]);
            }
            block = self.child(index, block, key)?;
        }
        Ok(block)
    }

    /// Puts lines taken by [`YamlDoc::entry`] at `path`, replacing what is
    /// there now; refused when the replaced lines define an anchor.
    pub fn put(&mut self, path: &[&str], entry: &[String]) -> Result<(), String> {
        let Some((last, parents)) = path.split_last() else {
            return Ok(());
        };
        let block = self.ensure_block(parents)?;
        let pad = " ".repeat(block.indent);
        let lines: Vec<String> = entry
            .iter()
            .map(|line| {
                if line.trim().is_empty() {
                    String::new()
                } else {
                    format!("{pad}{line}")
                }
            })
            .collect();
        match self.find(block, last)? {
            Some(index) => {
                let end = self.extent(index, block.indent, block.end);
                self.ensure_no_anchor(index, end, last)?;
                self.lines.splice(index..end, lines);
            }
            None => {
                let at = self.append_at(block);
                self.lines.splice(at..at, lines);
            }
        }
        Ok(())
    }

    /// Removes `path` with its whole value and the comments inside it; the
    /// comments before and after it stay. Refused when the value defines an
    /// anchor or the path runs through a flow collection or a list.
    pub fn remove(&mut self, path: &[&str]) -> Result<(), String> {
        let Some((index, end, _)) = self.locate(path)? else {
            return Ok(());
        };
        self.ensure_no_anchor(index, end, path.last().copied().unwrap_or_default())?;
        self.lines.drain(index..end);
        Ok(())
    }

    /// Removes `path` only while it is an empty mapping (`key:` or
    /// `key: {}` with no children).
    pub fn remove_if_empty(&mut self, path: &[&str]) -> Result<(), String> {
        let Some((index, end, _)) = self.locate(path)? else {
            return Ok(());
        };
        let (_, _, rest) = parse_key(self.lines[index].trim_start()).unwrap_or_default();
        let value = split_comment(rest).0;
        let empty = (value.is_empty() || value == "{}")
            && (index + 1..end).all(|line| ignorable(&self.lines[line]));
        if empty {
            self.lines.drain(index..end);
        }
        Ok(())
    }

    fn block_map(&self, block: Block) -> Result<Map<String, Value>, String> {
        let mut map = Map::new();
        let mut index = block.start;
        while index < block.end {
            let line = &self.lines[index];
            if ignorable(line) {
                index += 1;
                continue;
            }
            let trimmed = line.trim_start();
            if indent_of(line) != block.indent {
                return Err("YAML 缩进不一致".to_string());
            }
            let Some((key, _, rest)) = parse_key(trimmed) else {
                return Err(if is_sequence_item(trimmed) && block.start == 0 {
                    "YAML 顶层不是映射".to_string()
                } else {
                    "YAML 含无法安全解析的写法（如复杂键）".to_string()
                });
            };
            let end = self.extent(index, block.indent, block.end);
            let (inline, _) = split_comment(rest);
            let value = if inline.is_empty() {
                match self.child(index, block, &key) {
                    Ok(child)
                        if child.start == child.end || self.content(child).next().is_none() =>
                    {
                        Value::Null
                    }
                    Ok(child) => Value::Object(self.block_map(child)?),
                    Err(_) => Value::Array(Vec::new()),
                }
            } else if inline.starts_with(['|', '>']) {
                Value::String(String::new())
            } else {
                scalar(inline)
            };
            map.insert(key, value);
            index = end;
        }
        Ok(map)
    }

    /// Block mappings as JSON objects, scalars as strings or booleans, flow
    /// collections parsed when they are JSON; sequences come back empty.
    pub fn to_map(&self) -> Result<Map<String, Value>, String> {
        self.block_map(self.root())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(text: &str, path: &[&str], value: &str) -> String {
        let mut doc = YamlDoc::parse(text).unwrap();
        doc.set(path, value).unwrap();
        doc.serialize()
    }

    #[test]
    fn replaces_in_place_and_keeps_comments_and_sequences() {
        let text = "# top\nmodel:\n  # which model\n  default: \"old\"  # keep me\n  provider: auto\nplugins:\n  enabled:\n  - a\n  - b\ntail: 1\n";
        let out = set(text, &["model", "default"], "\"new/one\"");
        assert_eq!(
            out,
            "# top\nmodel:\n  # which model\n  default: \"new/one\" # keep me\n  provider: auto\nplugins:\n  enabled:\n  - a\n  - b\ntail: 1\n"
        );
    }

    #[test]
    fn appends_missing_keys_to_the_right_block() {
        let text = "model:\n    default: x\nother: 2\n";
        let out = set(text, &["model", "base_url"], "\"http://h/v1\"");
        assert_eq!(
            out,
            "model:\n    default: x\n    base_url: \"http://h/v1\"\nother: 2\n"
        );
        let out = set(text, &["providers", "tokenledger", "model"], "\"m\"");
        assert_eq!(
            out,
            "model:\n    default: x\nother: 2\nproviders:\n  tokenledger:\n    model: \"m\"\n"
        );
        assert_eq!(set("", &["a", "b"], "1"), "a:\n  b: 1\n");
        assert_eq!(set("model: {}\n", &["model", "a"], "1"), "model:\n  a: 1\n");
    }

    #[test]
    fn replacing_a_mapping_value_drops_its_old_children() {
        let text = "providers:\n  tokenledger:\n    baseUrl: old\n    models:\n      - id: x\n  other:\n    a: 1\n";
        let out = set(
            text,
            &["providers", "tokenledger"],
            "{\"baseUrl\": \"new\"}",
        );
        assert_eq!(
            out,
            "providers:\n  tokenledger: {\"baseUrl\": \"new\"}\n  other:\n    a: 1\n"
        );
        let map = YamlDoc::parse(&out).unwrap().to_map().unwrap();
        assert_eq!(map["providers"]["tokenledger"]["baseUrl"], "new");
        assert_eq!(map["providers"]["other"]["a"], "1");
    }

    #[test]
    fn reads_quoted_and_plain_scalars() {
        let map = YamlDoc::parse(
            "---\na: 'it''s'\nb: \"x\\ty\" # c\nc: http://h:1/v1\nd: true\ne:\n  - 1\n\"f g\": z\n",
        )
        .unwrap()
        .to_map()
        .unwrap();
        assert_eq!(map["a"], "it's");
        assert_eq!(map["b"], "x\ty");
        assert_eq!(map["c"], "http://h:1/v1");
        assert_eq!(map["d"], true);
        assert_eq!(map["e"], Value::Array(Vec::new()));
        assert_eq!(map["f g"], "z");
    }

    #[test]
    fn refuses_what_it_cannot_edit_safely() {
        assert!(YamlDoc::parse("a: 1\n---\nb: 2\n").is_err());
        assert!(YamlDoc::parse("a:\n\tb: 1\n").is_err());
        assert!(YamlDoc::parse("- a\n- b\n").is_err());
        let mut doc = YamlDoc::parse("model: gpt\nlist:\n  - a\nref: &x 1\n").unwrap();
        assert!(doc
            .set(&["model", "default"], "1")
            .unwrap_err()
            .contains("不是块状映射"));
        assert!(doc.set(&["list", "a"], "1").unwrap_err().contains("列表"));
        assert!(doc.set(&["ref"], "2").unwrap_err().contains("锚点"));
    }

    fn remove(text: &str, path: &[&str]) -> String {
        let mut doc = YamlDoc::parse(text).unwrap();
        doc.remove(path).unwrap();
        doc.serialize()
    }

    #[test]
    fn removes_scalars_and_whole_blocks_keeping_neighbour_comments() {
        let text = "# top\ndefaultModel: x # inline\n# about providers\ncustom_provider:\n  relay:\n    kind: custom\n  # gateway entry\n  tokenledger:\n    # inside\n    options:\n      baseURL: http://h/v1\n    models:\n      - a\n  # after\n  other: {}\ntail: 1\n";
        assert_eq!(
            remove(text, &["defaultModel"]),
            "# top\n# about providers\ncustom_provider:\n  relay:\n    kind: custom\n  # gateway entry\n  tokenledger:\n    # inside\n    options:\n      baseURL: http://h/v1\n    models:\n      - a\n  # after\n  other: {}\ntail: 1\n"
        );
        assert_eq!(
            remove(text, &["custom_provider", "tokenledger"]),
            "# top\ndefaultModel: x # inline\n# about providers\ncustom_provider:\n  relay:\n    kind: custom\n  # gateway entry\n  # after\n  other: {}\ntail: 1\n"
        );
        assert_eq!(remove(text, &["missing", "key"]), text);
        assert_eq!(remove(text, &["custom_provider", "nope"]), text);
    }

    #[test]
    fn empty_parents_are_removed_only_when_asked() {
        let mut doc =
            YamlDoc::parse("a: 1\nparent:\n  # note\n  child:\n    x: 1\nb: 2\n").unwrap();
        doc.remove(&["parent", "child"]).unwrap();
        assert_eq!(doc.serialize(), "a: 1\nparent:\n  # note\nb: 2\n");
        assert_eq!(doc.to_map().unwrap()["parent"], Value::Null);
        doc.remove_if_empty(&["parent"]).unwrap();
        assert_eq!(doc.serialize(), "a: 1\n  # note\nb: 2\n");
        let mut doc = YamlDoc::parse("parent:\n  keep: 1\nflow: {}\n").unwrap();
        doc.remove_if_empty(&["parent"]).unwrap();
        doc.remove_if_empty(&["flow"]).unwrap();
        assert_eq!(doc.serialize(), "parent:\n  keep: 1\n");
    }

    #[test]
    fn copies_entries_between_documents_reindenting_them() {
        let source = YamlDoc::parse(
            "providers:\n    tokenledger:\n        # mine\n        url: old\n        list:\n        - x\nmodel: old # was\n",
        )
        .unwrap();
        let entry = source
            .entry(&["providers", "tokenledger"])
            .unwrap()
            .unwrap();
        assert_eq!(
            entry,
            [
                "tokenledger:",
                "    # mine",
                "    url: old",
                "    list:",
                "    - x"
            ]
        );
        let mut doc =
            YamlDoc::parse("providers:\n  other: 1\n  tokenledger:\n    url: new\nmodel: new\n")
                .unwrap();
        doc.put(&["providers", "tokenledger"], &entry).unwrap();
        doc.put(&["model"], &source.entry(&["model"]).unwrap().unwrap())
            .unwrap();
        assert_eq!(
            doc.serialize(),
            "providers:\n  other: 1\n  tokenledger:\n      # mine\n      url: old\n      list:\n      - x\nmodel: old # was\n"
        );
        let map = YamlDoc::parse(&doc.serialize()).unwrap().to_map().unwrap();
        assert_eq!(map["providers"]["tokenledger"]["url"], "old");

        let mut doc = YamlDoc::parse("x: 1\n").unwrap();
        doc.put(&["providers", "tokenledger"], &entry).unwrap();
        assert!(doc
            .serialize()
            .starts_with("x: 1\nproviders:\n  tokenledger:\n      # mine\n"));
        assert!(source.entry(&["providers", "none"]).unwrap().is_none());
    }

    #[test]
    fn refuses_removals_it_cannot_do_safely() {
        let mut doc = YamlDoc::parse(
            "base: &b\n  url: x\nnested:\n  inner:\n    url: &u y\nflow: {tokenledger: 1}\nlist:\n  - tokenledger: 1\nuse: *b\n",
        )
        .unwrap();
        let before = doc.serialize();
        assert!(doc.remove(&["base"]).unwrap_err().contains("锚点"));
        assert!(doc
            .remove(&["nested", "inner"])
            .unwrap_err()
            .contains("锚点"));
        assert!(doc
            .remove(&["flow", "tokenledger"])
            .unwrap_err()
            .contains("不是块状映射"));
        assert!(doc
            .remove(&["list", "tokenledger"])
            .unwrap_err()
            .contains("列表"));
        assert!(doc
            .put(&["nested", "inner"], &["inner: 1".to_string()])
            .unwrap_err()
            .contains("锚点"));
        assert_eq!(doc.serialize(), before);
        doc.remove(&["use"]).unwrap();
        assert!(!doc.serialize().contains("use:"));
    }

    #[test]
    fn renders_flow_collections_readable_by_yaml_parsers() {
        let value = serde_json::json!({"a": "x", "n": [1, {"b": true}]});
        assert_eq!(render(&value), "{\"a\": \"x\", \"n\": [1, {\"b\": true}]}");
    }
}
