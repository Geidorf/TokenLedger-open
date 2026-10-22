//! IPC preview is a projection of changed leaves, never raw source/context.
//! Keys are retained for review, while credential values (including nested
//! objects/arrays and existing gateway credentials) are masked before diffing.
use super::super::codex_config::mask;
use serde_json::{Map, Value};

fn sensitive(key: &str) -> bool {
    let key = key.rsplit('.').next().unwrap_or(key);
    let key: String = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect();
    if key == "tokenledger" {
        return false;
    }
    key == "key"
        || [
            "apikey",
            "token",
            "secret",
            "password",
            "passwd",
            "bearer",
            "authorization",
            "credential",
            "privatekey",
            "accesskey",
        ]
        .iter()
        .any(|part| key.contains(part))
}
fn hidden(value: &Value, token: &str) -> Value {
    if value.as_str() == Some(token) && !token.is_empty() {
        Value::String(mask(token, token))
    } else if value.is_null() {
        Value::Null
    } else {
        Value::String("[已隐藏]".into())
    }
}
fn safe_string(text: &str, token: &str) -> String {
    let text = mask(text, token);
    if let Some((scheme, rest)) = text.split_once("://") {
        let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        let host = authority
            .rsplit_once('@')
            .map(|(_, host)| format!("[已隐藏]@{host}"))
            .unwrap_or_else(|| authority.to_string());
        let tail = &rest[authority_end..];
        let end = tail.find(['?', '#']).unwrap_or(tail.len());
        let suffix = if end < tail.len() { "?[已隐藏]" } else { "" };
        return format!("{scheme}://{host}{}{suffix}", &tail[..end]);
    }
    text
}
fn redact(value: &Value, token: &str) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        if sensitive(k) {
                            hidden(v, token)
                        } else {
                            redact(v, token)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(|v| redact(v, token)).collect()),
        Value::String(s) => Value::String(safe_string(s, token)),
        other => other.clone(),
    }
}
fn leaf(path: &str, value: &Value, token: &str, env: bool) -> String {
    let value = if sensitive(path) {
        hidden(value, token)
    } else {
        redact(value, token)
    };
    if env {
        format!(
            "{path}={}",
            value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string())
        )
    } else {
        format!("{path} = {value}")
    }
}
fn walk(
    path: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    token: &str,
    env: bool,
    old: &mut Vec<String>,
    new: &mut Vec<String>,
) {
    if before == after {
        return;
    }
    // Sensitive parents are masked as a whole; no child leaks its content.
    if !sensitive(path)
        && (before.is_none() || before.is_some_and(Value::is_object))
        && (after.is_none() || after.is_some_and(Value::is_object))
    {
        let mut keys = Vec::new();
        for map in [
            before.and_then(Value::as_object),
            after.and_then(Value::as_object),
        ]
        .into_iter()
        .flatten()
        {
            for key in map.keys() {
                if !keys.contains(key) {
                    keys.push(key.clone());
                }
            }
        }
        for key in keys {
            let next = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            walk(
                &next,
                before.and_then(|v| v.get(&key)),
                after.and_then(|v| v.get(&key)),
                token,
                env,
                old,
                new,
            );
        }
    } else {
        if let Some(v) = before {
            old.push(leaf(path, v, token, env));
        }
        if let Some(v) = after {
            new.push(leaf(path, v, token, env));
        }
    }
}
pub(crate) fn projection(
    before: Option<&Map<String, Value>>,
    after: &Map<String, Value>,
    token: &str,
    env: bool,
) -> (String, String) {
    let before = Value::Object(before.cloned().unwrap_or_default());
    let after = Value::Object(after.clone());
    let (mut old, mut new) = (Vec::new(), Vec::new());
    walk(
        "",
        Some(&before),
        Some(&after),
        token,
        env,
        &mut old,
        &mut new,
    );
    (old.join("\n"), new.join("\n"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_credentials_and_query_secrets_are_hidden() {
        let before = serde_json::json!({"base_url":"https://user:password-secret@example.test/v1?api_key=query-secret#fragment-secret"});
        let after = serde_json::json!({"base_url":"http://127.0.0.1:1/v1"});
        let (old, new) = projection(
            before.as_object(),
            after.as_object().unwrap(),
            "tl-token-abcd",
            false,
        );
        for secret in ["password-secret", "query-secret", "fragment-secret"] {
            assert!(!old.contains(secret));
        }
        assert!(old.contains("example.test/v1"));
        assert!(new.contains("127.0.0.1"));
    }
    #[test]
    fn recursive_mixed_case_credentials_and_arrays_are_redacted() {
        let before = serde_json::json!({"model":"old", "auth":{"API_KEY":"one","nested":[{"Secret":"two","passWord":"three","Bearer":"four"}]}, "providers":{"other":{"apiKey":"unchanged"}}});
        let after = serde_json::json!({"model":"new", "auth":{"API_KEY":"five","nested":[{"Secret":"six","passWord":"seven","Bearer":"eight"}]}, "providers":{"other":{"apiKey":"unchanged"}}});
        let (a, b) = projection(
            before.as_object(),
            after.as_object().unwrap(),
            "tl-example-abcd",
            false,
        );
        let text = format!("{a}{b}");
        for secret in [
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "unchanged",
        ] {
            assert!(!text.contains(secret), "{secret}: {text}");
        }
        assert!(text.contains("model"));
        assert!(text.contains("API_KEY"));
        assert!(!text.contains("providers.other"));
    }
}
