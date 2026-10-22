//! G5: the project-index module logs only literals, counts and reason codes
//! (spec §3.8), and never formats a path.

const SOURCES: &[(&str, &str)] = &[
    ("project_index.rs", include_str!("../../project_index.rs")),
    ("label.rs", include_str!("../label.rs")),
    ("git_probe.rs", include_str!("../git_probe.rs")),
    ("json_probe.rs", include_str!("../json_probe.rs")),
    ("sources.rs", include_str!("../sources.rs")),
    ("store.rs", include_str!("../store.rs")),
    ("behavior_view.rs", include_str!("../behavior_view.rs")),
];

/// Interpolations a log line may carry: counts, flags and reason codes.
///
/// Limit of this text-based guard (review P3-d): it checks placeholder
/// *names*, not what they hold. Binding a path to an allowed name
/// (`let code = path.to_string_lossy(); log::warn!("… {code}")`) passes it;
/// only code review can catch that. Every `{code}` today comes from a
/// `&'static str` reason code.
const ALLOWED_PLACEHOLDERS: &[&str] = &["resolved", "skipped", "removed", "wal_truncated", "code"];

/// Ways to write text outside the `log` path: the print and debug macros,
/// and any direct handle to standard error or output (`write!` or
/// `writeln!` into `std::io::stderr()`, `stdout().write_all(…)`).
///
/// This is text matching as well (review P3-d): a renamed import
/// (`use std::io::stderr as err;`) or a writer handed in from another module
/// slips through. Only code review catches those.
const FORBIDDEN_OUTPUT: &[&str] = &[
    "println!",
    "eprintln!",
    "print!(",
    "eprint!(",
    "dbg!",
    "stderr(",
    "stdout(",
];

/// The first forbidden output pattern in `source`, if any.
fn forbidden_output(source: &str) -> Option<&'static str> {
    FORBIDDEN_OUTPUT
        .iter()
        .copied()
        .find(|pattern| source.contains(pattern))
}

/// Argument text of every `log::<level>!(…)` invocation.
fn log_invocations(source: &str) -> Vec<String> {
    let mut invocations = Vec::new();
    let mut rest = source;
    while let Some(at) = rest.find("log::") {
        let after = &rest[at + "log::".len()..];
        let name_len = after
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
            .count();
        let Some(args) = after[name_len..].strip_prefix("!(") else {
            rest = after;
            continue;
        };
        let mut depth = 1usize;
        let mut in_string = false;
        let mut escaped = false;
        let mut end = None;
        for (index, ch) in args.char_indices() {
            if in_string {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    in_string = false;
                }
                continue;
            }
            match ch {
                '"' => in_string = true,
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(index);
                        break;
                    }
                }
                _ => {}
            }
        }
        let end = end.expect("balanced log macro");
        invocations.push(args[..end].to_string());
        rest = &args[end..];
    }
    invocations
}

fn placeholders(literal: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = literal;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        if let Some(stripped) = after.strip_prefix('{') {
            rest = stripped;
            continue;
        }
        let close = after.find('}').expect("closed placeholder");
        names.push(after[..close].to_string());
        rest = &after[close + 1..];
    }
    names
}

#[test]
fn g5_log_lines_carry_only_counts_and_codes() {
    let mut checked = 0usize;
    for (file, source) in SOURCES {
        for invocation in log_invocations(source) {
            let text = invocation.trim().trim_end_matches(',').trim();
            assert!(
                text.starts_with('"') && text.ends_with('"') && text.len() >= 2,
                "{file}: log arguments must be a single string literal: {text}"
            );
            let literal = &text[1..text.len() - 1];
            assert!(
                !literal.contains("\","),
                "{file}: no positional arguments after the literal: {text}"
            );
            for name in placeholders(literal) {
                assert!(
                    ALLOWED_PLACEHOLDERS.contains(&name.as_str()),
                    "{file}: placeholder {{{name}}} is not a count or reason code"
                );
            }
            checked += 1;
        }
        assert!(
            !source.contains(".display()"),
            "{file}: paths must never be formatted"
        );
        assert_eq!(
            forbidden_output(source),
            None,
            "{file} writes output directly"
        );
    }
    assert!(
        checked >= 4,
        "the guard must actually see the module's log lines"
    );
}

#[test]
fn g5_output_guard_catches_every_direct_write() {
    // Review P3-d: `print!`, `eprint!` and writes to stderr slipped past the
    // earlier list of three macros.
    for sample in [
        "print!(\"{name}\");",
        "eprint!(\"{}\", name);",
        "println!(\"{name}\");",
        "eprintln!(\"{name}\");",
        "dbg!(&path);",
        "let _ = writeln!(std::io::stderr(), \"{name}\");",
        "let _ = write!(io::stderr().lock(), \"{name}\");",
        "let _ = std::io::stdout().write_all(name.as_bytes());",
    ] {
        assert!(forbidden_output(sample).is_some(), "not caught: {sample}");
    }
    assert_eq!(
        forbidden_output("log::info!(\"project index pass done: resolved {resolved}\");"),
        None
    );
}

#[test]
fn g5_logging_macros_are_only_reached_through_the_log_path() {
    // Review §4.5 mutation 4: `use log::warn;` (or an alias) would let a
    // log line bypass the literal check above.
    for (file, source) in SOURCES {
        for forbidden in ["use log", "log as ", "extern crate log"] {
            assert!(
                !source.contains(forbidden),
                "{file}: `{forbidden}` would hide log lines from the guard"
            );
        }
        for level in ["trace", "debug", "info", "warn", "error"] {
            let call = format!("{level}!(");
            let mut rest: &str = source;
            while let Some(at) = rest.find(&call) {
                assert!(
                    rest[..at].ends_with("log::"),
                    "{file}: write `log::{call}`, never a bare `{call}`"
                );
                rest = &rest[at + call.len()..];
            }
        }
    }
}
