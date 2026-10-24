//! Reading the peer's sync folder on a WebDAV server, laid out as the peer lays it
//! out (`internal/davsync/dav.go`): `<address>/<its folder>/<its backup file>` (`peer_wire`).

use std::net::IpAddr;
use std::time::Duration;

use reqwest::{StatusCode, Url};

pub const FOLDER: &str = crate::peer_wire::DAV_FOLDER;
pub const BACKUP_FILE: &str = crate::peer_wire::DAV_BACKUP_FILE;
/// A setup backup is small; anything far larger is not one.
const MAX_BACKUP_BYTES: usize = 32 * 1024 * 1024;

/// The WebDAV base as the peer reads it: http(s), a host, no trailing slash.
pub fn parse_base(address: &str) -> Result<Url, String> {
    let mut url = Url::parse(address.trim())
        .map_err(|_| "WebDAV 地址无效（应为 https://…）。".to_string())?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err("WebDAV 地址无效（应为 https://…）。".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("WebDAV 地址里不要写账号密码，请填在下方的用户名与密码里。".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("WebDAV 地址不能包含查询参数或片段。".to_string());
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Ok(url)
}

/// `<base>/<parts…>`, as the peer's `dav.url` joins them.
pub fn file_url(base: &Url, parts: &[&str]) -> Result<Url, String> {
    let mut url = base.clone();
    let path = format!("{}/{}", base.path().trim_end_matches('/'), parts.join("/"));
    url.set_path(&path);
    Ok(url)
}

pub struct DavClient {
    base: Url,
    user: String,
    password: String,
    client: reqwest::Client,
}

impl DavClient {
    pub fn new(address: &str, user: &str, password: &str) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| format!("无法创建 WebDAV 客户端：{error}"))?;
        Ok(Self {
            base: parse_base(address)?,
            user: user.to_string(),
            password: password.to_string(),
            client,
        })
    }

    fn authorized(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::RequestBuilder, String> {
        if self.user.is_empty() && self.password.is_empty() {
            return Ok(request);
        }
        if !may_send_credentials(&self.base) {
            return Err(
                "WebDAV 地址是 http://，账号密码会明文传输。请改用 https://（本机或局域网地址除外）。"
                    .to_string(),
            );
        }
        Ok(request.basic_auth(&self.user, Some(&self.password)))
    }

    /// Reads the peer's backup; `None` when the folder has none yet.
    pub async fn get_backup(&self) -> Result<Option<Vec<u8>>, String> {
        self.get_file(&[FOLDER, BACKUP_FILE], MAX_BACKUP_BYTES)
            .await
    }

    /// Reads `<base>/<parts…>`; `None` when it isn't there.
    pub async fn get_file(&self, parts: &[&str], max: usize) -> Result<Option<Vec<u8>>, String> {
        let url = file_url(&self.base, parts)?;
        let request = self.authorized(
            self.client
                .get(url)
                // The file as it is, not a compressed copy (the peer #1362).
                .header(reqwest::header::ACCEPT_ENCODING, "identity"),
        )?;
        let mut response = request
            .send()
            .await
            .map_err(|error| format!("连接 WebDAV 服务器失败：{}", error.without_url()))?;
        match response.status() {
            StatusCode::NOT_FOUND => return Ok(None),
            StatusCode::UNAUTHORIZED => {
                return Err("WebDAV 服务器拒绝了用户名或密码（HTTP 401）。".to_string())
            }
            StatusCode::FORBIDDEN => {
                return Err("WebDAV 账号无权访问这个文件夹（HTTP 403）。".to_string())
            }
            StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => {
                return Err("WebDAV 服务器繁忙或限制了访问频率，请稍后再试。".to_string())
            }
            status if !status.is_success() => {
                return Err(format!("WebDAV 服务器返回 HTTP {}。", status.as_u16()))
            }
            _ => {}
        }
        if response
            .content_length()
            .is_some_and(|length| length as usize > max)
        {
            return Err("服务器上的同步文件过大，不像外部网关的备份。".to_string());
        }
        // Counted as it arrives: a server may leave out Content-Length.
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("读取 WebDAV 文件失败：{}", error.without_url()))?
        {
            if body.len() + chunk.len() > max {
                return Err("服务器上的同步文件过大，不像外部网关的备份。".to_string());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Some(body))
    }

    /// The files in `<base>/<parts…>/` with their ETags (empty when the
    /// server gives none); an empty list when the folder isn't there.
    pub async fn list(&self, parts: &[&str]) -> Result<Vec<(String, String)>, String> {
        let mut url = file_url(&self.base, parts)?;
        let folder = format!("{}/", url.path());
        url.set_path(&folder);
        let method = reqwest::Method::from_bytes(b"PROPFIND").map_err(|error| error.to_string())?;
        let request = self.authorized(
            self.client
                .request(method, url.clone())
                .header("Depth", "1")
                .header(reqwest::header::CONTENT_TYPE, "application/xml"),
        )?;
        let mut response = request
            .send()
            .await
            .map_err(|error| format!("连接 WebDAV 服务器失败：{}", error.without_url()))?;
        match response.status() {
            StatusCode::NOT_FOUND | StatusCode::CONFLICT | StatusCode::GONE => {
                return Ok(Vec::new())
            }
            StatusCode::UNAUTHORIZED => {
                return Err("WebDAV 服务器拒绝了用户名或密码（HTTP 401）。".to_string())
            }
            StatusCode::MULTI_STATUS => {}
            status => {
                return Err(format!(
                    "列出 WebDAV 文件夹失败（HTTP {}）。",
                    status.as_u16()
                ))
            }
        }
        // Counted as it arrives, as `get_file` does.
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("读取 WebDAV 文件夹列表失败：{}", error.without_url()))?
        {
            if body.len() + chunk.len() > MAX_BACKUP_BYTES {
                return Err("WebDAV 文件夹列表过大。".to_string());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(listed_files(&String::from_utf8_lossy(&body), url.path()))
    }
}

/// The text of every `<…href>` and `<…getetag>` element, in order, whatever
/// namespace prefix the server uses.
fn elements<'a>(xml: &'a str, name: &str) -> Vec<(usize, &'a str)> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(offset) = xml[at..].find('<') {
        let open = at + offset;
        let Some(close) = xml[open..].find('>').map(|end| open + end) else {
            break;
        };
        let tag = &xml[open + 1..close];
        let local = tag.split_whitespace().next().unwrap_or("");
        let local = local.rsplit(':').next().unwrap_or(local);
        at = close + 1;
        if tag.starts_with('/') || tag.ends_with('/') || !local.eq_ignore_ascii_case(name) {
            continue;
        }
        if let Some(end) = xml[at..].find("</") {
            found.push((open, xml[at..at + end].trim()));
        }
    }
    found
}

/// The files a PROPFIND multistatus names directly under `folder` (a URL
/// path ending in `/`), each with its ETag.
pub fn listed_files(xml: &str, folder: &str) -> Vec<(String, String)> {
    let hrefs = elements(xml, "href");
    let etags = elements(xml, "getetag");
    let mut files = Vec::new();
    for (index, (at, href)) in hrefs.iter().enumerate() {
        let next = hrefs.get(index + 1).map_or(xml.len(), |(next, _)| *next);
        let etag = etags
            .iter()
            .find(|(position, _)| position > at && *position < next)
            .map(|(_, etag)| etag.trim_matches('"').replace("&quot;", ""))
            .unwrap_or_default();
        let href = href.replace("&amp;", "&");
        // A server may answer with whole URLs or with paths.
        let path = Url::parse(&href).map_or(href.clone(), |url| url.path().to_string());
        let decoded = percent_decode(&path);
        let folder = percent_decode(folder);
        let Some(name) = decoded.strip_prefix(folder.as_str()) else {
            continue;
        };
        if name.is_empty() || name.contains('/') {
            continue;
        }
        files.push((name.to_string(), etag));
    }
    files
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &bytes[index + 1..index + 3];
            if hex.iter().all(u8::is_ascii_hexdigit) {
                let digit = |ch: u8| (ch as char).to_digit(16).unwrap_or(0) as u8;
                out.push(digit(hex[0]) * 16 + digit(hex[1]));
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Basic auth over plain http only stays on this computer or the local
/// network (a NAS at home); anywhere else it needs https.
pub fn may_send_credentials(base: &Url) -> bool {
    if base.scheme() == "https" {
        return true;
    }
    let Some(host) = base.host_str() else {
        return false;
    };
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            let first = ip.segments()[0];
            ip.is_loopback() || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
        }
        Err(_) => host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local"),
    }
}
