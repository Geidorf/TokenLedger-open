//! Usage the peer shares on the WebDAV folder (contract `peer-sync-v1` §6).
//!
//! Each computer running the peer puts a file per day beside the backup:
//! `<folder>/usage/<computer id>-<YYYY-MM-DD><ext>`, sealed with the sync
//! passphrase, holding the gzipped JSON of that day's calls. TokenLedger
//! only reads them, and only for the computers the user picked: a computer
//! that also runs TokenLedger already counts its calls itself.

use std::collections::BTreeMap;
use std::io::Read;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::backup::{self, Opener};
use super::dav::{DavClient, FOLDER};
use crate::commands::peer_shared::{parse_call, SharedCall, SharedComputer};
use crate::peer_wire::{config_dir, DAV_USAGE_FOLDER, LOCAL_COMPUTER_FILE, USAGE_FILE_EXT};

/// The peer keeps this many days on the server.
pub const SHARED_DAYS: i64 = 90;
/// A sealed day of one computer; far larger is not one.
const MAX_DAY_BYTES: usize = 64 * 1024 * 1024;
/// Its unpacked JSON.
const MAX_PLAIN_BYTES: u64 = 256 * 1024 * 1024;
const MAX_COMPUTERS: usize = 64;

/// A computer that shares usage on the server.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteComputer {
    pub id: String,
    /// Its host name as the peer wrote it in its newest day.
    pub name: String,
    pub days: usize,
    pub latest: String,
    pub enabled: bool,
}

/// `(computer id, day)` of a shared day's file name.
pub fn parse_name(name: &str) -> Option<(String, NaiveDate)> {
    let stem = name.strip_suffix(USAGE_FILE_EXT)?;
    if stem.len() < 12 || !stem.is_char_boundary(stem.len() - 11) {
        return None;
    }
    let (id, rest) = stem.split_at(stem.len() - 11);
    let day = rest.strip_prefix('-')?;
    let day = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some((id.to_ascii_lowercase(), day))
}

/// The peer's id for this computer, whose own usage TokenLedger reads from
/// its local file and must not count twice.
pub fn local_computer() -> Option<String> {
    #[derive(Deserialize)]
    struct Local {
        id: String,
    }
    let path = config_dir()?.join(LOCAL_COMPUTER_FILE);
    let local: Local = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    Some(local.id.trim().to_ascii_lowercase()).filter(|id| !id.is_empty())
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SharedDay {
    computer: String,
    name: String,
    calls: Vec<serde_json::Value>,
}

/// A day's name and counted calls, from its unsealed bytes.
pub fn parse_day(computer: &str, packed: &[u8]) -> Result<(String, Vec<SharedCall>), String> {
    let broken = || "外部网关共享的用量文件无法识别。".to_string();
    let mut plain = Vec::new();
    flate2::read::GzDecoder::new(packed)
        .take(MAX_PLAIN_BYTES + 1)
        .read_to_end(&mut plain)
        .map_err(|_| broken())?;
    if plain.len() as u64 > MAX_PLAIN_BYTES {
        return Err("外部网关共享的用量文件过大。".to_string());
    }
    let day: SharedDay = serde_json::from_slice(&plain).map_err(|_| broken())?;
    if !day.computer.is_empty() && !day.computer.eq_ignore_ascii_case(computer) {
        return Err(broken());
    }
    let calls = day
        .calls
        .iter()
        .filter_map(|value| parse_call(computer, value))
        .collect();
    Ok((day.name.trim().chars().take(128).collect(), calls))
}

/// Shared days on the server, by computer, newest last; this computer's own
/// and days past the peer's window left out.
fn group(files: Vec<(String, String)>, local: Option<&str>, today: NaiveDate) -> Days {
    let oldest = today - chrono::Duration::days(SHARED_DAYS);
    let mut days: Days = BTreeMap::new();
    for (name, _) in files {
        let Some((id, day)) = parse_name(&name) else {
            continue;
        };
        if Some(id.as_str()) == local || day < oldest {
            continue;
        }
        days.entry(id).or_default().push((day, name));
    }
    for list in days.values_mut() {
        list.sort();
    }
    while days.len() > MAX_COMPUTERS {
        days.pop_last();
    }
    days
}

type Days = BTreeMap<String, Vec<(NaiveDate, String)>>;

pub struct SharedSource {
    client: DavClient,
    passphrase: String,
}

impl SharedSource {
    pub fn new(client: DavClient, passphrase: String) -> Self {
        Self { client, passphrase }
    }

    async fn days(&self) -> Result<Days, String> {
        let files = self.client.list(&[FOLDER, DAV_USAGE_FOLDER]).await?;
        Ok(group(
            files,
            local_computer().as_deref(),
            chrono::Local::now().date_naive(),
        ))
    }

    async fn fetch(&self, name: &str) -> Result<Vec<u8>, String> {
        self.client
            .get_file(&[FOLDER, DAV_USAGE_FOLDER, name], MAX_DAY_BYTES)
            .await?
            .ok_or_else(|| "共享用量文件在读取时被删除了，请重试。".to_string())
    }

    /// Opens and reads fetched days off the async runtime: the key is
    /// derived once per salt, but even once is 600000 rounds.
    async fn open_all(&self, fetched: Vec<(String, Vec<u8>)>) -> Result<Vec<DayRead>, String> {
        let passphrase = self.passphrase.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut opener = Opener::new(&passphrase);
            fetched
                .into_iter()
                .map(|(computer, sealed)| {
                    let packed = opener
                        .open(&sealed, backup::DATA_FORMAT)
                        .map_err(|error| error.message().to_string())?;
                    let (name, calls) = parse_day(&computer, &packed)?;
                    Ok(DayRead {
                        computer,
                        name,
                        calls,
                    })
                })
                .collect()
        })
        .await
        .map_err(|error| error.to_string())?
    }

    /// The computers sharing usage, `selected` marked enabled.
    pub async fn computers(&self, selected: &[String]) -> Result<Vec<RemoteComputer>, String> {
        let days = self.days().await?;
        let mut fetched = Vec::new();
        for (id, list) in &days {
            if let Some((_, name)) = list.last() {
                fetched.push((id.clone(), self.fetch(name).await?));
            }
        }
        let names: BTreeMap<String, String> = self
            .open_all(fetched)
            .await?
            .into_iter()
            .map(|day| (day.computer, day.name))
            .collect();
        Ok(days
            .iter()
            .map(|(id, list)| RemoteComputer {
                id: id.clone(),
                name: names.get(id).cloned().unwrap_or_default(),
                days: list.len(),
                latest: list
                    .last()
                    .map(|(day, _)| day.to_string())
                    .unwrap_or_default(),
                enabled: selected.iter().any(|picked| picked == id),
            })
            .collect())
    }

    /// Every shared call of the `selected` computers still on the server.
    pub async fn pull(
        &self,
        selected: &[String],
    ) -> Result<(Vec<SharedCall>, Vec<SharedComputer>), String> {
        let days = self.days().await?;
        let mut fetched = Vec::new();
        for id in selected {
            for (_, name) in days.get(id).into_iter().flatten() {
                fetched.push((id.clone(), self.fetch(name).await?));
            }
        }
        let mut computers: BTreeMap<String, SharedComputer> = BTreeMap::new();
        let mut calls = Vec::new();
        for day in self.open_all(fetched).await? {
            let entry = computers
                .entry(day.computer.clone())
                .or_insert_with(|| SharedComputer {
                    id: day.computer.clone(),
                    ..SharedComputer::default()
                });
            // Days come oldest first: the newest name wins.
            if !day.name.is_empty() {
                entry.name = day.name;
            }
            entry.days += 1;
            entry.calls += day.calls.len();
            calls.extend(day.calls);
        }
        Ok((calls, computers.into_values().collect()))
    }
}

struct DayRead {
    computer: String,
    name: String,
    calls: Vec<SharedCall>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gzip(text: &str) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(text.as_bytes()).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn names_carry_computer_and_day() {
        let name = format!("0a1B2c3d4e5f6a7b-2026-10-21{USAGE_FILE_EXT}");
        assert_eq!(
            parse_name(&name),
            Some((
                "0a1b2c3d4e5f6a7b".to_string(),
                NaiveDate::from_ymd_opt(2026, 10, 21).unwrap()
            ))
        );
        for bad in [
            format!("-2026-10-21{USAGE_FILE_EXT}"),
            format!("zz-2026-10-21{USAGE_FILE_EXT}"),
            format!("ab-2026-13-01{USAGE_FILE_EXT}"),
            "ab-2026-10-21.json".to_string(),
            format!("ab/cd-2026-10-21{USAGE_FILE_EXT}"),
            format!("é-2026-10-21{USAGE_FILE_EXT}"),
        ] {
            assert_eq!(parse_name(&bad), None, "{bad}");
        }
    }

    #[test]
    fn grouping_leaves_out_this_computer_and_old_days() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 23).unwrap();
        let file = |id: &str, day: &str| (format!("{id}-{day}{USAGE_FILE_EXT}"), String::new());
        let days = group(
            vec![
                file("aa", "2026-10-22"),
                file("aa", "2026-10-20"),
                file("bb", "2026-10-22"),
                file("cc", "2026-01-01"),
                ("notes.txt".to_string(), String::new()),
            ],
            Some("bb"),
            today,
        );
        assert_eq!(days.keys().collect::<Vec<_>>(), ["aa"]);
        let aa: Vec<String> = days["aa"].iter().map(|(day, _)| day.to_string()).collect();
        assert_eq!(aa, ["2026-10-20", "2026-10-22"]);
    }

    #[test]
    fn a_day_keeps_counted_calls_only() {
        let day = serde_json::json!({
            "computer": "aa",
            "name": "studio",
            "day": "2026-10-22",
            "calls": [
                {"t": "2026-10-22T01:02:03Z", "agent": "claude", "provider": "p", "model": "m",
                 "in": 10, "out": 5, "ms": 1200, "status": 200, "source": "gateway"},
                {"t": "2026-10-22T01:02:04Z", "provider": "", "status": 429, "in": 3},
                {"t": "2026-10-22T01:02:05Z", "provider": "p", "rejected": true, "in": 3},
                {"t": "2026-10-22T01:02:06Z", "provider": "p", "in": 0, "out": 0},
                {"t": "not a time", "provider": "p", "in": 1},
                {"t": "2026-10-22T01:02:07Z", "provider": "p", "in": -1, "out": 4},
                "junk"
            ]
        });
        let (name, calls) = parse_day("aa", &gzip(&day.to_string())).unwrap();
        assert_eq!(name, "studio");
        assert_eq!(calls.len(), 1);
        let call = &calls[0];
        assert_eq!(call.computer, "aa");
        assert_eq!((call.input, call.out, call.ms), (10, 5, 1200));
        assert_eq!(call.t, "2026-10-22T01:02:03+00:00");
        assert_eq!(call.key.len(), 16);
    }

    #[test]
    fn a_day_of_another_computer_or_not_gzip_is_refused() {
        let day = serde_json::json!({"computer": "bb", "calls": []}).to_string();
        assert!(parse_day("aa", &gzip(&day)).is_err());
        assert!(parse_day("aa", day.as_bytes()).is_err());
    }

    /// A WebDAV server holding `files` in the peer's usage folder, until
    /// the test ends.
    fn serve(files: Vec<(String, Vec<u8>)>) -> u16 {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let folder = format!("/dav/{FOLDER}/{DAV_USAGE_FOLDER}/");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 2 {
                    line.clear();
                }
                let mut parts = first.split_whitespace();
                let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                let (status, body) = if method == "PROPFIND" && path == folder {
                    let mut xml = format!(
                        "<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>{folder}</d:href></d:response>"
                    );
                    for (name, _) in &files {
                        xml.push_str(&format!(
                            "<d:response><d:href>http://127.0.0.1:{port}{folder}{name}</d:href><d:propstat><d:prop><d:getetag>\"e\"</d:getetag></d:prop></d:propstat></d:response>"
                        ));
                    }
                    xml.push_str("</d:multistatus>");
                    ("207 Multi-Status", xml.into_bytes())
                } else if let Some((_, body)) = files
                    .iter()
                    .find(|(name, _)| method == "GET" && path == format!("{folder}{name}"))
                {
                    ("200 OK", body.clone())
                } else {
                    ("404 Not Found", Vec::new())
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        port
    }

    #[test]
    fn lists_computers_and_pulls_only_the_picked_ones() {
        let today = chrono::Local::now().date_naive();
        let day = |offset: i64| (today - chrono::Duration::days(offset)).to_string();
        let sealed_day = |computer: &str, name: &str, input: i64| {
            let plain = serde_json::json!({
                "computer": computer, "name": name,
                "calls": [{"t": "2026-10-22T01:02:03Z", "provider": "p", "model": "m", "in": input}]
            });
            backup::seal(
                &gzip(&plain.to_string()),
                "pass",
                backup::DATA_FORMAT,
                100_000,
            )
            .unwrap()
        };
        let files = vec![
            (
                format!("aa-{}{USAGE_FILE_EXT}", day(2)),
                sealed_day("aa", "old-name", 1),
            ),
            (
                format!("aa-{}{USAGE_FILE_EXT}", day(1)),
                sealed_day("aa", "studio", 2),
            ),
            (
                format!("bb-{}{USAGE_FILE_EXT}", day(1)),
                sealed_day("bb", "laptop", 3),
            ),
            ("readme.txt".to_string(), b"hi".to_vec()),
        ];
        let port = serve(files);
        let client = DavClient::new(&format!("http://127.0.0.1:{port}/dav"), "", "").unwrap();
        let source = SharedSource::new(client, "pass".to_string());

        let computers =
            tauri::async_runtime::block_on(source.computers(&["bb".to_string()])).unwrap();
        assert_eq!(computers.len(), 2);
        assert_eq!(
            (
                computers[0].id.as_str(),
                computers[0].name.as_str(),
                computers[0].days
            ),
            ("aa", "studio", 2)
        );
        assert_eq!(computers[0].latest, day(1));
        assert!(!computers[0].enabled && computers[1].enabled);

        let (calls, pulled) =
            tauri::async_runtime::block_on(source.pull(&["aa".to_string()])).unwrap();
        assert_eq!(
            calls.iter().map(|call| call.input).collect::<Vec<_>>(),
            [1, 2]
        );
        assert!(calls.iter().all(|call| call.computer == "aa"));
        assert_eq!(
            pulled,
            vec![SharedComputer {
                id: "aa".into(),
                name: "studio".into(),
                days: 2,
                calls: 2
            }]
        );

        let wrong = SharedSource::new(
            DavClient::new(&format!("http://127.0.0.1:{port}/dav"), "", "").unwrap(),
            "nope".to_string(),
        );
        assert!(tauri::async_runtime::block_on(wrong.pull(&["aa".to_string()])).is_err());
    }

    #[test]
    fn the_opener_reads_many_days_under_one_salt() {
        let first = backup::seal(b"one", "pass", backup::DATA_FORMAT, 100_000).unwrap();
        let second = backup::seal(b"two", "pass", backup::DATA_FORMAT, 100_000).unwrap();
        let mut opener = Opener::new("pass");
        assert_eq!(opener.open(&first, backup::DATA_FORMAT).unwrap(), b"one");
        assert_eq!(opener.open(&second, backup::DATA_FORMAT).unwrap(), b"two");
        assert_eq!(
            Opener::new("wrong").open(&first, backup::DATA_FORMAT),
            Err(backup::OpenError::Passphrase)
        );
        assert_eq!(
            opener.open(&first, backup::BACKUP_FORMAT),
            Err(backup::OpenError::NotSealed)
        );
    }
}
