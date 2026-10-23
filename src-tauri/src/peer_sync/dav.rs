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

    /// Reads the peer's backup with the version the server gave it; `None`
    /// when the folder has none yet.
    pub async fn get_remote(&self) -> Result<Option<Remote>, String> {
        let url = file_url(&self.base, &[FOLDER, BACKUP_FILE])?;
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
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if response
            .content_length()
            .is_some_and(|length| length as usize > MAX_BACKUP_BYTES)
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
            if body.len() + chunk.len() > MAX_BACKUP_BYTES {
                return Err("服务器上的同步文件过大，不像外部网关的备份。".to_string());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Some(Remote { body, etag }))
    }

    /// Writes the backup over the version read, as the peer's own push does:
    /// `If-Match` with its ETag, so a computer that wrote in between is not
    /// overwritten. The file is then read back whole.
    pub async fn put_backup(&self, body: Vec<u8>, read: &Remote) -> Result<(), String> {
        let url = file_url(&self.base, &[FOLDER, BACKUP_FILE])?;
        // A server without ETags: the file must still be the one read.
        if read.etag.is_none() {
            match self.get_remote().await? {
                Some(now) if now.body == read.body => {}
                _ => return Err(CHANGED.to_string()),
            }
        }
        let mut request = self
            .client
            .put(url)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream");
        if let Some(etag) = &read.etag {
            request = request.header(reqwest::header::IF_MATCH, etag);
        }
        let response = self
            .authorized(request.body(body.clone()))?
            .send()
            .await
            .map_err(|error| format!("写入 WebDAV 失败：{}", error.without_url()))?;
        match response.status() {
            StatusCode::PRECONDITION_FAILED => return Err(CHANGED.to_string()),
            StatusCode::UNAUTHORIZED => {
                return Err("WebDAV 服务器拒绝了用户名或密码（HTTP 401）。".to_string())
            }
            StatusCode::FORBIDDEN => {
                return Err("WebDAV 账号没有写入权限（HTTP 403）。".to_string())
            }
            status if !status.is_success() => {
                return Err(format!("WebDAV 写入失败：HTTP {}。", status.as_u16()))
            }
            _ => {}
        }
        match self.get_remote().await? {
            Some(back) if back.body == body => Ok(()),
            _ => Err(
                "写入后读回的文件与写入的不一致，可能被中途截断。请在外部网关里检查同步状态。"
                    .to_string(),
            ),
        }
    }
}

/// The backup as read, and the server's version of it.
#[derive(Debug, Clone)]
pub struct Remote {
    pub body: Vec<u8>,
    pub etag: Option<String>,
}

const CHANGED: &str = "服务器上的外部网关备份刚被其他电脑改过。请重新读取后再写入。";

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
