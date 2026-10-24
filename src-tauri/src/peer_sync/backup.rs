//! The peer's sealed file format (`internal/backup`), byte-compatible both ways.
//!
//! A sealed file is JSON: an envelope naming how it is sealed, and the
//! content encrypted with AES-256-GCM under a key derived from the passphrase
//! with PBKDF2-HMAC-SHA256. The envelope's own fields are the additional
//! authenticated data, so none of them can be changed unnoticed. Byte fields
//! are standard base64, as Go's `encoding/json` writes `[]byte`.

use std::num::NonZeroU32;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::pbkdf2;
use serde::{Deserialize, Serialize};

/// The whole-setup backup.
pub const BACKUP_FORMAT: &str = crate::peer_wire::BACKUP_FORMAT;
/// Any other file the peer seals, such as shared usage days.
pub const DATA_FORMAT: &str = crate::peer_wire::DATA_FORMAT;
/// The peer's own iteration count, for files TokenLedger seals.
#[allow(dead_code)] // nothing is sealed for the peer yet
pub const ITERATIONS: u32 = 600_000;
const KDF: &str = "pbkdf2-sha256";
const VERSION: u32 = 1;
/// Iteration counts a sealed file may name. The peer writes 600000; the
/// cap keeps one file from costing more than a few seconds to open.
const MIN_ITERATIONS: u32 = 100_000;
pub const MAX_ITERATIONS: u32 = 2_000_000;
/// PBKDF2 rounds one [`Opener`] spends in all: enough for every computer the
/// shared folder may list under a few salts each, and a bound on the CPU a
/// folder full of differently salted files can take.
pub const OPENER_ROUNDS: u64 = 128 * 600_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    /// Not a sealed the peer file at all (an empty body, a server's page).
    NotSealed,
    /// Begins like one but is cut short or its fields don't read.
    Corrupt,
    /// Sealed by a newer the peer with another version or KDF.
    Newer,
    /// The passphrase does not open it, or the file was changed.
    Passphrase,
    /// Opening it would derive more keys than one read allows.
    TooManyKeys,
}

impl OpenError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::NotSealed => "服务器上的文件不是外部网关的同步文件。",
            Self::Corrupt => "外部网关同步文件已损坏或不完整。",
            Self::Newer => "这个同步文件由更新版本的外部网关生成，TokenLedger 还读不了。",
            Self::Passphrase => "同步密码不对，或文件已被改动。",
            Self::TooManyKeys => "服务器上的共享用量文件用了过多不同的加密参数，已停止读取。",
        }
    }
}

mod b64 {
    use super::{Engine, STANDARD};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        STANDARD.decode(text).map_err(serde::de::Error::custom)
    }
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    version: u32,
    kdf: String,
    iterations: u32,
    #[serde(with = "b64")]
    salt: Vec<u8>,
    #[serde(with = "b64")]
    nonce: Vec<u8>,
    #[serde(with = "b64")]
    data: Vec<u8>,
}

fn header(envelope: &Envelope) -> Vec<u8> {
    let salt: String = envelope
        .salt
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!(
        "{}/{}/{}/{}/{salt}",
        envelope.format, envelope.version, envelope.kdf, envelope.iterations
    )
    .into_bytes()
}

fn derive(passphrase: &str, salt: &[u8], iterations: u32) -> Result<[u8; 32], OpenError> {
    let iterations = NonZeroU32::new(iterations).ok_or(OpenError::Corrupt)?;
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        salt,
        passphrase.as_bytes(),
        &mut key,
    );
    Ok(key)
}

fn aead_key(raw: &[u8; 32]) -> Result<LessSafeKey, OpenError> {
    let unbound = UnboundKey::new(&AES_256_GCM, raw).map_err(|_| OpenError::Corrupt)?;
    Ok(LessSafeKey::new(unbound))
}

fn key_for(passphrase: &str, envelope: &Envelope) -> Result<LessSafeKey, OpenError> {
    aead_key(&derive(passphrase, &envelope.salt, envelope.iterations)?)
}

/// Opens many files sealed with one passphrase, deriving each salt's key
/// once: the peer seals every shared file under the same salt, and 600000
/// rounds per file would make a few months of days take minutes. Once the
/// keys derived add up to [`OPENER_ROUNDS`], a file under yet another salt
/// is refused instead of opened.
pub struct Opener {
    passphrase: String,
    keys: std::collections::HashMap<(Vec<u8>, u32), [u8; 32]>,
    rounds_left: u64,
}

impl Opener {
    pub fn new(passphrase: &str) -> Self {
        Self::with_rounds(passphrase, OPENER_ROUNDS)
    }

    #[cfg_attr(not(test), allow(dead_code))] // tests shrink the budget
    pub fn with_rounds(passphrase: &str, rounds: u64) -> Self {
        Self {
            passphrase: passphrase.to_string(),
            keys: std::collections::HashMap::new(),
            rounds_left: rounds,
        }
    }

    pub fn open(&mut self, data: &[u8], format: &str) -> Result<Vec<u8>, OpenError> {
        let passphrase = &self.passphrase;
        let keys = &mut self.keys;
        let rounds_left = &mut self.rounds_left;
        open_with(data, format, &mut |envelope| {
            let slot = (envelope.salt.clone(), envelope.iterations);
            let raw = match keys.get(&slot) {
                Some(raw) => *raw,
                None => {
                    let cost = u64::from(envelope.iterations);
                    if cost > *rounds_left {
                        return Err(OpenError::TooManyKeys);
                    }
                    *rounds_left -= cost;
                    let raw = derive(passphrase, &envelope.salt, envelope.iterations)?;
                    keys.insert(slot, raw);
                    raw
                }
            };
            aead_key(&raw)
        })
    }
}

/// Whether `data` begins like a sealed file of `format`, whitespace aside.
fn begins_like(data: &[u8], format: &str) -> bool {
    let head: String = String::from_utf8_lossy(&data[..data.len().min(256)])
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    head.starts_with(&format!(r#"{{"format":"{format}""#))
}

/// Opens a file the peer sealed as `format`.
pub fn open(data: &[u8], passphrase: &str, format: &str) -> Result<Vec<u8>, OpenError> {
    open_with(data, format, &mut |envelope| key_for(passphrase, envelope))
}

fn open_with(
    data: &[u8],
    format: &str,
    key_of: &mut dyn FnMut(&Envelope) -> Result<LessSafeKey, OpenError>,
) -> Result<Vec<u8>, OpenError> {
    let data = data.strip_prefix(b"\xef\xbb\xbf").unwrap_or(data);
    let Ok(envelope) = serde_json::from_slice::<Envelope>(data) else {
        return Err(if begins_like(data, format) {
            OpenError::Corrupt
        } else {
            OpenError::NotSealed
        });
    };
    if envelope.format != format {
        return Err(OpenError::NotSealed);
    }
    if envelope.version != VERSION || envelope.kdf != KDF {
        return Err(OpenError::Newer);
    }
    if !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&envelope.iterations)
        || envelope.nonce.len() != 12
        || envelope.salt.len() < 16
    {
        return Err(OpenError::Corrupt);
    }
    let key = key_of(&envelope)?;
    let nonce =
        Nonce::try_assume_unique_for_key(&envelope.nonce).map_err(|_| OpenError::Corrupt)?;
    let mut buffer = envelope.data.clone();
    let plain = key
        .open_in_place(nonce, Aad::from(header(&envelope)), &mut buffer)
        .map_err(|_| OpenError::Passphrase)?;
    Ok(plain.to_vec())
}

/// Seals `plain` as the peer would: a whole backup indented, as the peer's
/// `Seal` writes it, any other file compact.
#[cfg_attr(not(test), allow(dead_code))] // only the tests seal for now
pub fn seal(
    plain: &[u8],
    passphrase: &str,
    format: &str,
    iterations: u32,
) -> Result<Vec<u8>, String> {
    if passphrase.is_empty() {
        return Err("需要同步密码。".to_string());
    }
    let mut salt = vec![0u8; 16];
    let mut nonce = vec![0u8; 12];
    getrandom::fill(&mut salt).map_err(|error| error.to_string())?;
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let mut envelope = Envelope {
        format: format.to_string(),
        version: VERSION,
        kdf: KDF.to_string(),
        iterations,
        salt,
        nonce,
        data: Vec::new(),
    };
    let key = key_for(passphrase, &envelope).map_err(|error| error.message().to_string())?;
    let nonce = Nonce::try_assume_unique_for_key(&envelope.nonce).map_err(|_| "nonce")?;
    let mut buffer = plain.to_vec();
    key.seal_in_place_append_tag(nonce, Aad::from(header(&envelope)), &mut buffer)
        .map_err(|_| "加密失败。".to_string())?;
    envelope.data = buffer;
    if format == BACKUP_FORMAT {
        serde_json::to_vec_pretty(&envelope)
    } else {
        serde_json::to_vec(&envelope)
    }
    .map_err(|error| error.to_string())
}
