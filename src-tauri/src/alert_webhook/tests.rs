use super::payload::*;
use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

const FEISHU: &str = "https://open.feishu.cn/open-apis/bot/v2/hook/0f0e0d0c-test";
const DINGTALK: &str = "https://oapi.dingtalk.com/robot/send?access_token=test-token";
const WECOM: &str = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key";
const SLACK: &str = "https://hooks.slack.com/services/T000/B000/XXXX";
const DISCORD: &str = "https://discord.com/api/webhooks/123/abc";

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<String, StoredCredential>>);

impl CredentialStore for MemoryStore {
    fn load(&self, id: &str) -> Result<Option<StoredCredential>, String> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    fn save(&self, id: &str, credential: &StoredCredential) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(id.to_string(), credential.clone());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tokenledger_alert_webhook_{name}_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn input(platform: WebhookPlatform, url: Option<&str>) -> EndpointInput {
    EndpointInput {
        id: None,
        platform,
        name: String::new(),
        enabled: true,
        kinds: AlertKind::ALL.to_vec(),
        include_cost: false,
        url: url.map(str::to_string),
        secret: None,
        clear_secret: false,
    }
}

fn message(cost: Option<&str>) -> MessageText {
    MessageText {
        kind_key: "budget",
        kind_label: "预算提醒",
        title: "全部用量 预算已用 80%".to_string(),
        body: "本月费用预算已用 80%".to_string(),
        cost: cost.map(str::to_string),
    }
}

#[test]
fn chat_robot_addresses_must_point_at_the_platform() {
    for (platform, url) in [
        (WebhookPlatform::Feishu, FEISHU),
        (
            WebhookPlatform::Feishu,
            "https://open.larksuite.com/open-apis/bot/v2/hook/x",
        ),
        (WebhookPlatform::Dingtalk, DINGTALK),
        (WebhookPlatform::Wecom, WECOM),
        (WebhookPlatform::Slack, SLACK),
        (WebhookPlatform::Discord, DISCORD),
        (WebhookPlatform::Generic, "https://example.com/hook"),
        (WebhookPlatform::Generic, "http://127.0.0.1:5678/hook"),
        (WebhookPlatform::Generic, "http://localhost:5678/hook"),
    ] {
        assert!(normalize_url(platform, url).is_ok(), "{platform:?} {url}");
    }
    for (platform, url) in [
        (
            WebhookPlatform::Feishu,
            "http://open.feishu.cn/open-apis/bot/v2/hook/x",
        ),
        (
            WebhookPlatform::Feishu,
            "https://open.feishu.cn.example.com/open-apis/bot/v2/hook/x",
        ),
        (WebhookPlatform::Feishu, "https://open.feishu.cn/other"),
        (
            WebhookPlatform::Feishu,
            "https://open.feishu.cn:8443/open-apis/bot/v2/hook/x",
        ),
        (
            WebhookPlatform::Dingtalk,
            "https://oapi.dingtalk.com/robot/send",
        ),
        (
            WebhookPlatform::Wecom,
            "https://qyapi.weixin.qq.com/cgi-bin/webhook/send",
        ),
        (WebhookPlatform::Slack, "https://example.com/services/x"),
        (WebhookPlatform::Discord, "https://discord.com/channels/1"),
        (WebhookPlatform::Generic, "http://example.com/hook"),
        (
            WebhookPlatform::Generic,
            "https://user:pass@example.com/hook",
        ),
        (WebhookPlatform::Generic, "https://example.com/hook#frag"),
        (WebhookPlatform::Generic, "ftp://example.com/hook"),
        (WebhookPlatform::Generic, ""),
        (WebhookPlatform::Generic, "not a url"),
    ] {
        assert!(normalize_url(platform, url).is_err(), "{platform:?} {url}");
    }
}

#[test]
fn url_hint_keeps_only_the_host() {
    assert_eq!(url_hint(DINGTALK), "oapi.dingtalk.com");
    assert_eq!(url_hint(SLACK), "hooks.slack.com");
    assert_eq!(url_hint("nonsense"), "");
}

#[test]
fn signatures_match_the_platform_documented_algorithms() {
    // Reference values computed independently with Python's hmac module.
    assert_eq!(
        feishu_sign(1_700_000_000, "SECtest"),
        "G7XpBpG8NgG02fJOAhX6FRAObIljmFoxVReo8I62pEk="
    );
    assert_eq!(
        dingtalk_sign(1_700_000_000_123, "SECtest"),
        "lrMq5E54T40t3FfGVjxdvoqIbXlWY6mzkZYiVoI6emk="
    );
    assert_eq!(
        generic_sign(1_700_000_000, r#"{"a":1}"#, "SECtest"),
        "sha256=fcb51ec4942f871bf6bb7039d37a5ac7dd46311afc0620d07c5c84f8958cb4d1"
    );
}

fn body_json(request: &PreparedRequest) -> serde_json::Value {
    serde_json::from_str(&request.body).unwrap()
}

#[test]
fn each_platform_gets_its_own_message_shape() {
    let at = 1_700_000_000_123;
    let msg = message(None);

    let feishu = build_request(WebhookPlatform::Feishu, FEISHU, Some("SECtest"), &msg, at).unwrap();
    let body = body_json(&feishu);
    assert_eq!(body["msg_type"], "text");
    assert!(body["content"]["text"]
        .as_str()
        .unwrap()
        .starts_with("【TokenLedger · 预算提醒】"));
    assert_eq!(body["timestamp"], "1700000000");
    assert_eq!(body["sign"], feishu_sign(1_700_000_000, "SECtest"));
    let unsigned = build_request(WebhookPlatform::Feishu, FEISHU, None, &msg, at).unwrap();
    assert!(body_json(&unsigned).get("sign").is_none());

    let ding = build_request(
        WebhookPlatform::Dingtalk,
        DINGTALK,
        Some("SECtest"),
        &msg,
        at,
    )
    .unwrap();
    let url = reqwest::Url::parse(&ding.url).unwrap();
    let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(pairs["access_token"], "test-token");
    assert_eq!(pairs["timestamp"], "1700000000123");
    assert_eq!(pairs["sign"], dingtalk_sign(at, "SECtest"));
    assert!(ding
        .url
        .contains("sign=lrMq5E54T40t3FfGVjxdvoqIbXlWY6mzkZYiVoI6emk%3D"));
    assert_eq!(body_json(&ding)["msgtype"], "text");

    let wecom = build_request(WebhookPlatform::Wecom, WECOM, None, &msg, at).unwrap();
    assert!(body_json(&wecom)["text"]["content"]
        .as_str()
        .unwrap()
        .contains("80%"));

    let slack_msg = MessageText {
        title: "<!channel> & co".to_string(),
        ..message(None)
    };
    let slack = build_request(WebhookPlatform::Slack, SLACK, None, &slack_msg, at).unwrap();
    let text = body_json(&slack)["text"].as_str().unwrap().to_string();
    assert!(text.contains("&lt;!channel&gt; &amp; co"));
    assert!(!text.contains("<!channel>"));

    let discord = build_request(WebhookPlatform::Discord, DISCORD, None, &msg, at).unwrap();
    let body = body_json(&discord);
    assert_eq!(body["allowed_mentions"]["parse"], serde_json::json!([]));

    let generic = build_request(
        WebhookPlatform::Generic,
        "https://example.com/hook",
        Some("SECtest"),
        &message(Some("已用 $40.00 / 上限 $50.00")),
        at,
    )
    .unwrap();
    let body = body_json(&generic);
    assert_eq!(body["source"], "tokenledger");
    assert_eq!(body["kind"], "budget");
    assert_eq!(body["cost"], "已用 $40.00 / 上限 $50.00");
    let signature = generic
        .headers
        .iter()
        .find(|(name, _)| *name == SIGNATURE_HEADER)
        .map(|(_, value)| value.clone())
        .unwrap();
    assert_eq!(
        signature,
        generic_sign(1_700_000_000, &generic.body, "SECtest")
    );
}

#[test]
fn long_text_is_cut_for_every_platform() {
    let long = MessageText {
        body: "长".repeat(5_000),
        ..message(None)
    };
    let discord = build_request(WebhookPlatform::Discord, DISCORD, None, &long, 0).unwrap();
    let content = body_json(&discord)["content"].as_str().unwrap().to_string();
    assert!(content.chars().count() <= 1_800);
    assert!(content.ends_with('…'));
}

#[test]
fn chat_robot_errors_come_from_the_body() {
    assert!(check_response(
        WebhookPlatform::Feishu,
        200,
        r#"{"code":0,"msg":"success"}"#
    )
    .is_ok());
    assert!(check_response(WebhookPlatform::Feishu, 200, r#"{"StatusCode":0}"#).is_ok());
    let error = check_response(
        WebhookPlatform::Feishu,
        200,
        r#"{"code":19021,"msg":"sign match fail"}"#,
    )
    .unwrap_err();
    assert!(error.contains("19021") && error.contains("sign match fail"));
    assert!(check_response(
        WebhookPlatform::Dingtalk,
        200,
        r#"{"errcode":310000,"errmsg":"sign not match"}"#
    )
    .is_err());
    assert!(check_response(
        WebhookPlatform::Wecom,
        200,
        r#"{"errcode":0,"errmsg":"ok"}"#
    )
    .is_ok());
    assert!(check_response(WebhookPlatform::Slack, 200, "ok").is_ok());
    assert!(check_response(WebhookPlatform::Discord, 204, "").is_ok());
    assert!(check_response(WebhookPlatform::Slack, 404, "no_service")
        .unwrap_err()
        .contains("404"));
    assert!(check_response(WebhookPlatform::Generic, 500, "").is_err());
}

fn endpoint(id: &str, kinds: &[AlertKind], include_cost: bool) -> WebhookEndpoint {
    WebhookEndpoint {
        id: id.to_string(),
        platform: WebhookPlatform::Generic,
        name: id.to_string(),
        enabled: true,
        kinds: kinds.to_vec(),
        include_cost,
        url_hint: "example.com".to_string(),
        has_secret: false,
    }
}

#[test]
fn deliveries_follow_switches_kinds_and_cost_choice() {
    let now = Utc::now();
    let mut settings = AlertWebhookSettings {
        enabled: false,
        endpoints: vec![
            endpoint("a", &[AlertKind::Budget, AlertKind::Anomaly], false),
            endpoint("b", &[AlertKind::Budget], true),
            endpoint("c", &[AlertKind::Quota], true),
        ],
    };
    let mut sent = HashMap::new();
    let plan = |settings: &AlertWebhookSettings, sent: &mut HashMap<_, _>, kind| {
        plan_deliveries(settings, sent, kind, "t", "b", Some("$1.00"), now)
    };
    assert!(
        plan(&settings, &mut sent, AlertKind::Budget).is_empty(),
        "master switch off"
    );

    settings.enabled = true;
    let planned = plan(&settings, &mut sent, AlertKind::Budget);
    let ids: Vec<_> = planned
        .iter()
        .map(|delivery| delivery.endpoint.id.as_str())
        .collect();
    assert_eq!(ids, ["a", "b"]);
    assert_eq!(
        planned[0].message.cost, None,
        "cost stays out unless opted in"
    );
    assert_eq!(planned[1].message.cost.as_deref(), Some("$1.00"));

    settings.endpoints[0].enabled = false;
    let planned = plan(&settings, &mut sent, AlertKind::Anomaly);
    assert!(planned.is_empty(), "disabled endpoint receives nothing");
}

#[test]
fn each_endpoint_has_an_hourly_safety_cap() {
    let start = Utc::now();
    let settings = AlertWebhookSettings {
        enabled: true,
        endpoints: vec![endpoint("a", &AlertKind::ALL, false)],
    };
    let mut sent = HashMap::new();
    for i in 0..ENDPOINT_HOURLY_LIMIT {
        let at = start + Duration::seconds(i as i64);
        assert_eq!(
            plan_deliveries(&settings, &mut sent, AlertKind::Quota, "t", "b", None, at).len(),
            1
        );
    }
    let at = start + Duration::minutes(30);
    assert!(plan_deliveries(&settings, &mut sent, AlertKind::Quota, "t", "b", None, at).is_empty());
    let later = start + Duration::minutes(61);
    assert_eq!(
        plan_deliveries(
            &settings,
            &mut sent,
            AlertKind::Quota,
            "t",
            "b",
            None,
            later
        )
        .len(),
        1
    );
}

#[test]
fn address_and_secret_stay_out_of_the_settings_file() {
    let dir = temp_dir("secrets");
    let store = MemoryStore::default();
    let mut new = input(WebhookPlatform::Dingtalk, Some(DINGTALK));
    new.secret = Some("SECtest".to_string());
    let saved = upsert_endpoint(&dir, &store, new).unwrap();
    assert!(saved.has_secret);
    assert_eq!(saved.url_hint, "oapi.dingtalk.com");
    assert_eq!(saved.name, "钉钉群");
    let file = std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap();
    assert!(
        !file.contains("test-token") && !file.contains("SECtest"),
        "{file}"
    );
    let stored = store.load(&saved.id).unwrap().unwrap();
    assert_eq!(stored.url, DINGTALK);
    assert_eq!(stored.secret.as_deref(), Some("SECtest"));
    assert!(!format!("{stored:?}").contains("SECtest"));
    assert!(!format!("{stored:?}").contains("test-token"));

    remove_endpoint(&dir, &store, &saved.id).unwrap();
    assert!(store.load(&saved.id).unwrap().is_none());
    assert!(load_settings(&dir).endpoints.is_empty());
}

#[test]
fn edits_keep_the_secret_only_for_the_same_host() {
    let dir = temp_dir("edits");
    let store = MemoryStore::default();
    let mut new = input(WebhookPlatform::Feishu, Some(FEISHU));
    new.secret = Some("SECtest".to_string());
    let saved = upsert_endpoint(&dir, &store, new).unwrap();

    // Rename and switch kinds without re-entering anything.
    let mut edit = input(WebhookPlatform::Feishu, None);
    edit.id = Some(saved.id.clone());
    edit.name = "  值班群  ".to_string();
    edit.kinds = vec![AlertKind::Quota, AlertKind::Budget, AlertKind::Quota];
    let edited = upsert_endpoint(&dir, &store, edit).unwrap();
    assert_eq!(edited.name, "值班群");
    assert_eq!(edited.kinds, vec![AlertKind::Budget, AlertKind::Quota]);
    assert!(edited.has_secret);

    // Another robot on the same host keeps the secret.
    let mut same_host = input(
        WebhookPlatform::Feishu,
        Some("https://open.feishu.cn/open-apis/bot/v2/hook/other"),
    );
    same_host.id = Some(saved.id.clone());
    assert!(upsert_endpoint(&dir, &store, same_host).unwrap().has_secret);

    // Moving to another host drops it.
    let mut other_host = input(
        WebhookPlatform::Feishu,
        Some("https://open.larksuite.com/open-apis/bot/v2/hook/x"),
    );
    other_host.id = Some(saved.id.clone());
    let moved = upsert_endpoint(&dir, &store, other_host).unwrap();
    assert!(!moved.has_secret);
    assert_eq!(store.load(&saved.id).unwrap().unwrap().secret, None);

    // Changing platform needs a new address.
    let mut switch = input(WebhookPlatform::Slack, None);
    switch.id = Some(saved.id.clone());
    assert!(upsert_endpoint(&dir, &store, switch).is_err());

    // Clearing the secret.
    let mut with_secret = input(WebhookPlatform::Feishu, None);
    with_secret.id = Some(saved.id.clone());
    with_secret.secret = Some("SECtwo".to_string());
    assert!(
        upsert_endpoint(&dir, &store, with_secret)
            .unwrap()
            .has_secret
    );
    let mut clear = input(WebhookPlatform::Feishu, None);
    clear.id = Some(saved.id.clone());
    clear.clear_secret = true;
    assert!(!upsert_endpoint(&dir, &store, clear).unwrap().has_secret);
}

#[test]
fn unsigned_platforms_never_store_a_secret_and_new_endpoints_need_an_address() {
    let dir = temp_dir("unsigned");
    let store = MemoryStore::default();
    let mut wecom = input(WebhookPlatform::Wecom, Some(WECOM));
    wecom.secret = Some("ignored".to_string());
    let saved = upsert_endpoint(&dir, &store, wecom).unwrap();
    assert!(!saved.has_secret);
    assert_eq!(store.load(&saved.id).unwrap().unwrap().secret, None);

    assert!(upsert_endpoint(&dir, &store, input(WebhookPlatform::Slack, None)).is_err());
    let mut missing = input(WebhookPlatform::Slack, Some(SLACK));
    missing.id = Some("wh-gone".to_string());
    assert!(upsert_endpoint(&dir, &store, missing).is_err());
}

#[test]
fn endpoint_count_is_capped() {
    let dir = temp_dir("cap");
    let store = MemoryStore::default();
    for _ in 0..MAX_ENDPOINTS {
        upsert_endpoint(&dir, &store, input(WebhookPlatform::Discord, Some(DISCORD))).unwrap();
    }
    assert!(upsert_endpoint(&dir, &store, input(WebhookPlatform::Discord, Some(DISCORD))).is_err());
}

#[test]
fn settings_default_off_and_bad_rows_are_dropped() {
    let dir = temp_dir("load");
    assert_eq!(load_settings(&dir), AlertWebhookSettings::default());
    let raw = serde_json::json!({
        "enabled": true,
        "endpoints": [
            { "id": "wh-1", "platform": "slack", "name": "x", "enabled": true, "kinds": ["quota", "nope"], "hasSecret": true },
            { "id": "../bad", "platform": "slack", "name": "x", "enabled": true, "kinds": [] },
            { "id": "wh-2", "platform": "unknown", "name": "x", "enabled": true, "kinds": [] },
        ],
    });
    crate::quota::write_private_app_data_file(&dir, SETTINGS_FILE, raw.to_string().as_bytes())
        .unwrap();
    let settings = load_settings(&dir);
    assert!(settings.enabled);
    assert_eq!(
        settings.endpoints.len(),
        1,
        "bad id and unknown platform are dropped"
    );
    let kept = &settings.endpoints[0];
    assert_eq!(kept.id, "wh-1");
    assert_eq!(kept.kinds, vec![AlertKind::Quota], "unknown kind skipped");
    assert!(!kept.has_secret, "slack never keeps a secret");
}

#[test]
fn forward_without_settings_is_a_no_op() {
    let dir = temp_dir("noop");
    forward(&dir, AlertKind::Budget, "t", "b", None);
    assert!(!dir.join(STATE_FILE).exists());
}

/// One-shot HTTP server on loopback: returns the raw request it received.
fn serve_once(
    status_line: &'static str,
    body: &'static str,
) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://127.0.0.1:{}/hook",
        listener.local_addr().unwrap().port()
    );
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(StdDuration::from_secs(5)))
            .unwrap();
        let mut raw = Vec::new();
        let mut buf = [0_u8; 4096];
        loop {
            let n = stream.read(&mut buf).unwrap_or(0);
            if n == 0 {
                break;
            }
            raw.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&raw);
            if let Some(split) = text.find("\r\n\r\n") {
                let length = text[..split]
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                if raw.len() >= split + 4 + length {
                    break;
                }
            }
        }
        let response = format!(
            "{status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        String::from_utf8_lossy(&raw).into_owned()
    });
    (url, handle)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn generic_hook_receives_a_signed_json_post() {
    let (url, server) = serve_once("HTTP/1.1 200 OK", "{}");
    let request = build_request(
        WebhookPlatform::Generic,
        &normalize_url(WebhookPlatform::Generic, &url).unwrap(),
        Some("SECtest"),
        &message(None),
        1_700_000_000_000,
    )
    .unwrap();
    runtime()
        .block_on(send(WebhookPlatform::Generic, &request))
        .unwrap();
    let raw = server.join().unwrap();
    assert!(raw.starts_with("POST /hook HTTP/1.1"));
    let lower = raw.to_ascii_lowercase();
    assert!(lower.contains("x-tokenledger-timestamp: 1700000000"));
    assert!(lower.contains(&format!(
        "x-tokenledger-signature: {}",
        generic_sign(1_700_000_000, &request.body, "SECtest")
    )));
    assert!(raw.ends_with(&request.body));
}

#[test]
fn redirects_are_not_followed_and_errors_hide_the_address() {
    let (url, server) = serve_once("HTTP/1.1 302 Found\r\nlocation: https://example.com/", "");
    let request = PreparedRequest {
        url: format!("{url}?token=very-secret"),
        headers: vec![("Content-Type", "application/json".to_string())],
        body: "{}".to_string(),
    };
    let error = runtime()
        .block_on(send(WebhookPlatform::Generic, &request))
        .unwrap_err();
    server.join().unwrap();
    assert!(error.contains("302"));
    assert!(!error.contains("very-secret"));

    // Nothing listens on this port: the connect error must not echo the URL.
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    let request = PreparedRequest {
        url: format!("http://127.0.0.1:{port}/hook?token=very-secret"),
        headers: Vec::new(),
        body: "{}".to_string(),
    };
    let error = runtime()
        .block_on(send(WebhookPlatform::Generic, &request))
        .unwrap_err();
    assert!(
        !error.contains("very-secret") && !error.contains("127.0.0.1"),
        "{error}"
    );
}
