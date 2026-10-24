//! Platform formats for alert webhooks: address checks, message bodies,
//! signatures and response checks. Pure functions, so every platform is
//! covered by unit tests without a network.

use std::net::IpAddr;

use base64::Engine;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_URL_BYTES: usize = 2_048;
const MAX_SECRET_BYTES: usize = 512;
/// Discord rejects content over 2000 characters; every platform gets the
/// same cap so a message reads the same everywhere.
const MAX_TEXT_CHARS: usize = 1_800;
const MAX_ERROR_CHARS: usize = 120;
pub(crate) const SIGNATURE_HEADER: &str = "X-TokenLedger-Signature";
pub(crate) const TIMESTAMP_HEADER: &str = "X-TokenLedger-Timestamp";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WebhookPlatform {
    Feishu,
    Dingtalk,
    Wecom,
    Slack,
    Discord,
    Generic,
}

impl WebhookPlatform {
    /// Platforms whose robots accept an optional signing secret.
    pub(crate) fn supports_secret(self) -> bool {
        matches!(self, Self::Feishu | Self::Dingtalk | Self::Generic)
    }

    fn allowed_hosts(self) -> &'static [&'static str] {
        match self {
            Self::Feishu => &["open.feishu.cn", "open.larksuite.com"],
            Self::Dingtalk => &["oapi.dingtalk.com"],
            Self::Wecom => &["qyapi.weixin.qq.com"],
            Self::Slack => &["hooks.slack.com"],
            Self::Discord => &[
                "discord.com",
                "discordapp.com",
                "ptb.discord.com",
                "canary.discord.com",
            ],
            Self::Generic => &[],
        }
    }

    fn path_prefixes(self) -> &'static [&'static str] {
        match self {
            Self::Feishu => &["/open-apis/bot/v2/hook/"],
            Self::Dingtalk => &["/robot/send"],
            Self::Wecom => &["/cgi-bin/webhook/send"],
            Self::Slack => &["/services/", "/workflows/", "/triggers/"],
            Self::Discord => &["/api/webhooks/"],
            Self::Generic => &[],
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Feishu => "飞书",
            Self::Dingtalk => "钉钉",
            Self::Wecom => "企业微信",
            Self::Slack => "Slack",
            Self::Discord => "Discord",
            Self::Generic => "Webhook",
        }
    }
}

/// Checks a pasted address against the platform. Chat robots must point at
/// the platform's own host, so a typo cannot send alerts somewhere else;
/// the generic hook takes any HTTPS address (HTTP only on this machine).
pub(crate) fn normalize_url(platform: WebhookPlatform, raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_URL_BYTES {
        return Err("Webhook 地址为空或过长。".to_string());
    }
    let url = Url::parse(raw).map_err(|_| "Webhook 地址不是有效的网址。".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Webhook 地址不能包含用户名或密码。".to_string());
    }
    if url.fragment().is_some() {
        return Err("Webhook 地址不能包含 # 片段。".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Webhook 地址缺少主机名。".to_string())?
        .to_ascii_lowercase();
    if platform == WebhookPlatform::Generic {
        let loopback = host == "localhost"
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .map(|address| address.is_loopback())
                .unwrap_or(false);
        if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
            return Err("Webhook 必须使用 HTTPS；只有本机地址可以用 HTTP。".to_string());
        }
        return Ok(url.to_string());
    }
    if url.scheme() != "https" || url.port().is_some_and(|port| port != 443) {
        return Err(format!("{} 机器人地址必须是 HTTPS。", platform.name()));
    }
    if !platform.allowed_hosts().contains(&host.as_str())
        || !platform
            .path_prefixes()
            .iter()
            .any(|prefix| url.path().starts_with(prefix))
    {
        return Err(format!(
            "这不像{}机器人地址，请从群机器人设置里复制完整的 Webhook 地址。",
            platform.name()
        ));
    }
    let has_query = |key: &str| {
        url.query_pairs()
            .any(|(name, value)| name == key && !value.is_empty())
    };
    match platform {
        WebhookPlatform::Dingtalk if !has_query("access_token") => {
            Err("钉钉机器人地址缺少 access_token。".to_string())
        }
        WebhookPlatform::Wecom if !has_query("key") => {
            Err("企业微信机器人地址缺少 key。".to_string())
        }
        _ => Ok(url.to_string()),
    }
}

/// What the settings page may show of a stored address: the host only. The
/// path and query carry the robot's token.
pub(crate) fn url_hint(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_default()
}

pub(crate) fn validate_secret(secret: &str) -> Result<(), String> {
    if secret.is_empty()
        || secret.len() > MAX_SECRET_BYTES
        || secret.trim() != secret
        || secret.chars().any(char::is_control)
    {
        return Err("签名密钥为空、过长，或包含首尾空白和控制字符。".to_string());
    }
    Ok(())
}

/// The text every platform shows. Cost lines are appended only when the
/// endpoint opted in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MessageText {
    pub kind_key: &'static str,
    pub kind_label: &'static str,
    pub title: String,
    pub body: String,
    pub cost: Option<String>,
}

impl MessageText {
    fn plain(&self) -> String {
        let mut text = format!(
            "【TokenLedger · {}】{}\n{}",
            self.kind_label, self.title, self.body
        );
        if let Some(cost) = &self.cost {
            text.push('\n');
            text.push_str(cost);
        }
        truncate_chars(&text, MAX_TEXT_CHARS)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreparedRequest {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key);
    ring::hmac::sign(&key, data).as_ref().to_vec()
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Feishu custom bot: the key is `timestamp + "\n" + secret`, the message is
/// empty, the result is Base64.
pub(crate) fn feishu_sign(timestamp_seconds: i64, secret: &str) -> String {
    base64(&hmac_sha256(
        format!("{timestamp_seconds}\n{secret}").as_bytes(),
        b"",
    ))
}

/// DingTalk custom robot: HMAC-SHA256 of `timestamp_ms + "\n" + secret`
/// keyed with the secret, Base64 (URL-encoded when appended).
pub(crate) fn dingtalk_sign(timestamp_ms: i64, secret: &str) -> String {
    base64(&hmac_sha256(
        secret.as_bytes(),
        format!("{timestamp_ms}\n{secret}").as_bytes(),
    ))
}

/// Generic hooks: hex HMAC-SHA256 of `timestamp + "." + body`, the same shape
/// receivers already verify for other webhook senders.
pub(crate) fn generic_sign(timestamp_seconds: i64, body: &str, secret: &str) -> String {
    format!(
        "sha256={}",
        hex(&hmac_sha256(
            secret.as_bytes(),
            format!("{timestamp_seconds}.{body}").as_bytes()
        ))
    )
}

/// Slack treats `<`, `>` and `&` as markup, so a label can never become a
/// mention or a link.
fn slack_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(crate) fn build_request(
    platform: WebhookPlatform,
    url: &str,
    secret: Option<&str>,
    message: &MessageText,
    sent_at_ms: i64,
) -> Result<PreparedRequest, String> {
    let text = message.plain();
    let seconds = sent_at_ms.div_euclid(1000);
    let mut url = Url::parse(url).map_err(|_| "Webhook 地址无效。".to_string())?;
    let mut headers = vec![("Content-Type", "application/json".to_string())];
    let body = match platform {
        WebhookPlatform::Feishu => {
            let mut body = json!({ "msg_type": "text", "content": { "text": text } });
            if let Some(secret) = secret {
                body["timestamp"] = Value::String(seconds.to_string());
                body["sign"] = Value::String(feishu_sign(seconds, secret));
            }
            body
        }
        WebhookPlatform::Dingtalk => {
            if let Some(secret) = secret {
                let sign = dingtalk_sign(sent_at_ms, secret);
                url.query_pairs_mut()
                    .append_pair("timestamp", &sent_at_ms.to_string())
                    .append_pair("sign", &sign);
            }
            json!({ "msgtype": "text", "text": { "content": text } })
        }
        WebhookPlatform::Wecom => json!({ "msgtype": "text", "text": { "content": text } }),
        WebhookPlatform::Slack => json!({ "text": slack_escape(&text) }),
        WebhookPlatform::Discord => json!({
            "content": text,
            "allowed_mentions": { "parse": [] },
        }),
        WebhookPlatform::Generic => {
            let mut body = json!({
                "source": "tokenledger",
                "version": 1,
                "kind": message.kind_key,
                "title": message.title,
                "body": message.body,
                "text": text,
                "sentAt": chrono::DateTime::from_timestamp_millis(sent_at_ms)
                    .map(|at| at.to_rfc3339())
                    .unwrap_or_default(),
            });
            if let Some(cost) = &message.cost {
                body["cost"] = Value::String(cost.clone());
            }
            body
        }
    };
    let body = serde_json::to_string(&body).map_err(|error| error.to_string())?;
    if platform == WebhookPlatform::Generic {
        if let Some(secret) = secret {
            headers.push((TIMESTAMP_HEADER, seconds.to_string()));
            headers.push((SIGNATURE_HEADER, generic_sign(seconds, &body, secret)));
        }
    }
    Ok(PreparedRequest {
        url: url.to_string(),
        headers,
        body,
    })
}

/// Chat robots answer HTTP 200 with an error code in the body, so the body
/// decides. The returned message is shown in settings; it never contains
/// the address.
pub(crate) fn check_response(
    platform: WebhookPlatform,
    status: u16,
    body: &str,
) -> Result<(), String> {
    if !(200..300).contains(&status) {
        let hint = match status {
            401 | 403 => "，地址或密钥可能已失效",
            404 => "，机器人可能已被删除",
            429 => "，发送太频繁被平台限流",
            _ => "",
        };
        return Err(format!("HTTP {status}{hint}"));
    }
    let parsed = serde_json::from_str::<Value>(body).ok();
    let code_and_message = |code_key: &str, message_key: &str| -> Result<(), String> {
        let Some(value) = parsed.as_ref() else {
            return Ok(());
        };
        let code = value.get(code_key).and_then(Value::as_i64).unwrap_or(0);
        if code == 0 {
            return Ok(());
        }
        let message = value
            .get(message_key)
            .and_then(Value::as_str)
            .unwrap_or_default();
        Err(format!(
            "平台返回错误 {code}：{}",
            truncate_chars(message, MAX_ERROR_CHARS)
        ))
    };
    match platform {
        WebhookPlatform::Feishu => {
            // Older Feishu hooks answer `StatusCode`; current ones `code`.
            let legacy = parsed.as_ref().is_some_and(|value| {
                value.get("code").is_none() && value.get("StatusCode").is_some()
            });
            if legacy {
                code_and_message("StatusCode", "StatusMessage")
            } else {
                code_and_message("code", "msg")
            }
        }
        WebhookPlatform::Dingtalk | WebhookPlatform::Wecom => code_and_message("errcode", "errmsg"),
        WebhookPlatform::Slack | WebhookPlatform::Discord | WebhookPlatform::Generic => Ok(()),
    }
}

pub(crate) fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}
