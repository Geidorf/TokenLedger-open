//! `Debug` for values that carry a secret: the secret's field prints only
//! whether it is set, so a stray `{:?}` in a log or a panic message never
//! carries a key, password or token.

use std::fmt;

/// A secret string as `Debug` shows it: `""` when empty, else a mask.
pub struct Hidden<'a>(pub &'a str);

impl fmt::Debug for Hidden<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_empty() {
            f.write_str("\"\"")
        } else {
            f.write_str("<redacted>")
        }
    }
}

/// An optional secret string as `Debug` shows it.
pub fn hidden_opt(value: &Option<String>) -> Option<Hidden<'_>> {
    value.as_deref().map(Hidden)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_prints_only_whether_it_is_set() {
        assert_eq!(format!("{:?}", Hidden("sk-live-secret")), "<redacted>");
        assert_eq!(format!("{:?}", Hidden("")), "\"\"");
        assert_eq!(format!("{:?}", hidden_opt(&None)), "None");
        assert_eq!(
            format!("{:?}", hidden_opt(&Some("pw".into()))),
            "Some(<redacted>)"
        );
    }
}
