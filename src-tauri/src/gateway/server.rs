use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderMap, AUTHORIZATION, CONTENT_TYPE, HOST, USER_AGENT};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use reqwest::Url;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Semaphore, SemaphorePermit};

use super::anthropic;
use super::context_size::{self, ContextApi, ContextSize};
use super::convert::{chat_to_response, responses_to_chat, ChatStream, StreamConverter};
use super::gemini::{self, GeminiPath, GeminiStream};
use super::ledger::{agent_from_user_agent, sse_data, LedgerRecord, SseLines, Usage};
use super::policy;
use super::routing::{
    body_session, build_trace, Features, RouteAttempt, RouteDecision, GROUP_PREFIX,
};
use super::store::{provider_account, validate_auth_mode, AuthMode, ProviderRecord, WireApi};
use super::Shared;

type Body = UnsyncBoxBody<Bytes, std::io::Error>;

const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
// Unit tests exercise identical timeout paths with short real HTTP delays.
const fn deadline(seconds: u64, test_millis: u64) -> Duration {
    if cfg!(test) {
        Duration::from_millis(test_millis)
    } else {
        Duration::from_secs(seconds)
    }
}
const REQUEST_READ_TIMEOUT: Duration = deadline(30, 300);
const UPSTREAM_HEADERS_TIMEOUT: Duration = deadline(60, 400);
const WHOLE_RESPONSE_TIMEOUT: Duration = deadline(300, 800);
// Test value leaves the stream case's 150 ms gaps a wide margin on loaded CI runners.
const STREAM_IDLE_TIMEOUT: Duration = deadline(120, 1000);
const CLIENT_SEND_TIMEOUT: Duration = deadline(30, 300);
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_STREAM_BYTES: usize = 64 * 1024 * 1024;
const MAX_CONVERSION_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONVERTED_EVENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 32;
const MAX_ACTIVE_REQUESTS: usize = 8;
const STREAM_QUEUE: usize = 2;
static REQUEST_SLOTS: Semaphore = Semaphore::const_new(MAX_ACTIVE_REQUESTS);
static SECRET_SLOTS: Semaphore = Semaphore::const_new(4);

/// Keep a slot until the response is consumed or dropped, including SSE.
struct GuardedBody {
    body: Body,
    permit: Option<SemaphorePermit<'static>>,
}
impl hyper::body::Body for GuardedBody {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let result = Pin::new(&mut self.body).poll_frame(cx);
        if matches!(result, Poll::Ready(None)) {
            self.permit.take();
        }
        result
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> hyper::body::SizeHint {
        self.body.size_hint()
    }
}

enum ListenerSocket {
    Pending(std::net::TcpListener),
    Ready(TcpListener),
}

/// The synchronous owner can close the socket before a restart binds again.
/// No lock is held across an await: accept borrows the socket for one poll.
pub(super) struct ListenerOwner {
    socket: std::sync::Mutex<Option<ListenerSocket>>,
}
impl ListenerOwner {
    pub(super) fn from_std(socket: std::net::TcpListener) -> Self {
        Self {
            socket: std::sync::Mutex::new(Some(ListenerSocket::Pending(socket))),
        }
    }
    pub(super) fn close(&self) {
        self.socket.lock().unwrap_or_else(|p| p.into_inner()).take();
    }
    async fn accept(&self) -> std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)> {
        futures_util::future::poll_fn(|cx| {
            let mut socket = self.socket.lock().unwrap_or_else(|p| p.into_inner());
            if matches!(socket.as_ref(), Some(ListenerSocket::Pending(_))) {
                let Some(ListenerSocket::Pending(pending)) = socket.take() else {
                    unreachable!()
                };
                *socket = Some(ListenerSocket::Ready(TcpListener::from_std(pending)?));
            }
            match socket.as_ref() {
                Some(ListenerSocket::Ready(listener)) => listener.poll_accept(cx),
                _ => Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "gateway stopped",
                ))),
            }
        })
        .await
    }
}

#[cfg(test)]
pub async fn serve(
    listener: TcpListener,
    shared: Arc<Shared>,
    token: Arc<str>,
    gate: Arc<AtomicBool>,
) {
    let listener = Arc::new(ListenerOwner {
        socket: std::sync::Mutex::new(Some(ListenerSocket::Ready(listener))),
    });
    serve_owned(listener, shared, token, gate).await;
}

pub(super) async fn serve_owned(
    listener: Arc<ListenerOwner>,
    shared: Arc<Shared>,
    token: Arc<str>,
    gate: Arc<AtomicBool>,
) {
    let mut tasks = tokio::task::JoinSet::new();
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            if !gate.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        let Ok(connection_permit) = connections.clone().try_acquire_owned() else {
            // No waiting queue: drop excess connections immediately.
            continue;
        };
        let shared = shared.clone();
        let token = token.clone();
        let gate = gate.clone();
        while tasks.try_join_next().is_some() {}
        tasks.spawn(async move {
            let _connection_permit = connection_permit;
            let service = service_fn(move |mut request: Request<Incoming>| {
                request.extensions_mut().insert(gate.clone());
                let shared = shared.clone();
                let token = token.clone();
                async move { Ok::<_, Infallible>(handle(request, shared, token).await) }
            });
            let _ = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(REQUEST_READ_TIMEOUT)
                .max_buf_size(64 * 1024)
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}

fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn json_response(status: StatusCode, value: &Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(full(value.to_string()))
        .expect("static response parts are valid")
}

fn error_response(status: StatusCode, message: &str) -> Response<Body> {
    json_response(
        status,
        // Top-level `type` makes the same body a valid Anthropic error too.
        &json!({"type": "error", "error": {"message": message, "type": "tokenledger_gateway_error"}}),
    )
}

fn host_allowed(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or_default()
    } else {
        host.rsplit_once(':').map(|(name, _)| name).unwrap_or(host)
    };
    policy::is_loopback_host(name)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Bearer, `x-api-key`, Gemini's `x-goog-api-key`, or Gemini's `?key=`
/// (request URIs are never logged).
fn authorized(headers: &HeaderMap, query: Option<&str>, token: &str) -> bool {
    let presented = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| {
            headers
                .get("x-api-key")
                .and_then(|value| value.to_str().ok())
        })
        .or_else(|| {
            headers
                .get("x-goog-api-key")
                .and_then(|value| value.to_str().ok())
        })
        .map(str::to_string)
        .or_else(|| gemini::query_param(query, "key"));
    presented.is_some_and(|value| constant_time_eq(value.trim().as_bytes(), token.as_bytes()))
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.chars().take(128).collect())
}

fn random_id() -> String {
    let mut raw = [0u8; 8];
    let _ = getrandom::fill(&mut raw);
    raw.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn handle(
    request: Request<Incoming>,
    shared: Arc<Shared>,
    token: Arc<str>,
) -> Response<Body> {
    if request
        .extensions()
        .get::<Arc<AtomicBool>>()
        .is_some_and(|gate| !gate.load(Ordering::SeqCst))
    {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "网关已停止，请重新连接。");
    }
    let permit = match REQUEST_SLOTS.try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "网关同时最多处理 8 个请求，请稍后重试。",
            )
        }
    };
    handle_inner(request, shared, token).await.map(|body| {
        GuardedBody {
            body,
            permit: Some(permit),
        }
        .boxed_unsync()
    })
}

async fn handle_inner(
    request: Request<Incoming>,
    shared: Arc<Shared>,
    token: Arc<str>,
) -> Response<Body> {
    if !host_allowed(request.headers()) {
        return error_response(
            StatusCode::FORBIDDEN,
            "只接受发往 127.0.0.1 或 localhost 的请求。",
        );
    }
    let path = request.uri().path().trim_end_matches('/').to_string();
    if request.method() == Method::GET && path == "/health" {
        return json_response(
            StatusCode::OK,
            &json!({"ok": true, "service": "tokenledger-gateway"}),
        );
    }
    let gemini_path = gemini::parse_path(&path);
    if !authorized(request.headers(), request.uri().query(), &token) {
        let message = "缺少或错误的本地网关 token。";
        return match gemini_path {
            Some(_) => gemini_error(StatusCode::UNAUTHORIZED, message),
            None => error_response(StatusCode::UNAUTHORIZED, message),
        };
    }
    if let Some(route) = gemini_path {
        return gemini_entry(request, shared, route).await;
    }
    match (request.method().clone(), path.as_str()) {
        (Method::GET, "/v1/models") => list_models(&shared),
        (Method::POST, "/v1/responses") => proxy(request, shared, Endpoint::Responses).await,
        (Method::POST, "/v1/chat/completions") => proxy(request, shared, Endpoint::Chat).await,
        (Method::POST, "/v1/messages") => proxy(request, shared, Endpoint::Messages).await,
        (Method::POST, "/v1/messages/count_tokens") => count_tokens(request).await,
        _ => error_response(StatusCode::NOT_FOUND, "网关没有这个接口。"),
    }
}

async fn count_tokens(request: Request<Incoming>) -> Response<Body> {
    match read_json(request).await {
        Ok(payload) => json_response(
            StatusCode::OK,
            &json!({"input_tokens": anthropic::estimate_input_tokens(&payload)}),
        ),
        Err(response) => response,
    }
}

/// `(model name, owner)` for every enabled provider model and routing group.
fn model_ids(shared: &Shared) -> Vec<(String, String)> {
    let providers = shared
        .providers
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut ids: Vec<(String, String)> = providers
        .iter()
        .filter(|provider| provider.enabled)
        .flat_map(|provider| {
            provider
                .models
                .iter()
                .map(move |model| (format!("{}/{model}", provider.id), provider.id.clone()))
        })
        .collect();
    drop(providers);
    ids.extend(
        shared
            .router
            .groups()
            .into_iter()
            .filter(|group| group.enabled)
            .map(|group| (group.model_name(), "tokenledger-group".to_string())),
    );
    ids
}

fn list_models(shared: &Shared) -> Response<Body> {
    let data: Vec<Value> = model_ids(shared)
        .into_iter()
        .map(|(id, owner)| json!({"id": id, "object": "model", "owned_by": owner}))
        .collect();
    json_response(StatusCode::OK, &json!({"object": "list", "data": data}))
}

fn gemini_error(status: StatusCode, message: &str) -> Response<Body> {
    json_response(status, &gemini::error_body(status.as_u16(), message))
}

/// Model identity is explicit on every outbound Gemini call. Auxiliary
/// calls with built-in names cannot inherit another client's provider/model.
fn resolve_gemini_model(model: &str) -> Result<String, String> {
    if model
        .split_once('/')
        .is_some_and(|(provider, name)| !provider.is_empty() && !name.is_empty())
    {
        Ok(model.to_string())
    } else {
        Err(format!(
            "模型名「{model}」需要写成 供应商ID/模型；请在 Gemini CLI 里选择网关返回的完整模型名。"
        ))
    }
}

async fn gemini_entry(
    request: Request<Incoming>,
    shared: Arc<Shared>,
    route_path: GeminiPath,
) -> Response<Body> {
    let method = request.method().clone();
    let (model, call) = match (route_path, method) {
        (GeminiPath::List, Method::GET) => {
            let models: Vec<Value> = model_ids(&shared)
                .iter()
                .map(|(id, _)| gemini::model_entry(id))
                .collect();
            return json_response(StatusCode::OK, &json!({"models": models}));
        }
        (GeminiPath::Model(model), Method::GET) => {
            return match model_ids(&shared).iter().find(|(id, _)| *id == model) {
                Some((id, _)) => json_response(StatusCode::OK, &gemini::model_entry(id)),
                None => gemini_error(StatusCode::NOT_FOUND, &format!("网关没有模型「{model}」。")),
            };
        }
        (GeminiPath::Call { model, method }, Method::POST) => (model, method),
        (GeminiPath::Unsupported(name), _) => {
            return gemini_error(
                StatusCode::NOT_FOUND,
                &format!("网关的 Gemini 接口不支持 {name}。"),
            );
        }
        _ => return gemini_error(StatusCode::METHOD_NOT_ALLOWED, "请求方法不受支持。"),
    };
    let gate = request.extensions().get::<Arc<AtomicBool>>().cloned();
    let headers = request.headers().clone();
    let body = match read_json(request).await {
        Ok(body) => body,
        Err(response) => return gemini_rewrap(response).await,
    };
    if call == gemini::Method::CountTokens {
        return json_response(StatusCode::OK, &gemini::count_tokens(&body));
    }
    let model = match resolve_gemini_model(&model) {
        Ok(model) => model,
        Err(message) => return gemini_error(StatusCode::BAD_REQUEST, &message),
    };
    let stream = call == gemini::Method::Stream;
    let payload = match gemini::gemini_to_chat(&body, &model, stream) {
        Ok(payload) => payload,
        Err(message) => return gemini_error(StatusCode::BAD_REQUEST, &message),
    };
    let mut ctx = request_ctx(&headers, Endpoint::Gemini, model, stream);
    ctx.gate = gate;
    ctx.context = context_size::measure(ContextApi::Gemini, &body);
    gemini_rewrap(route(ctx, &shared, &payload).await).await
}

/// Gateway and upstream errors in Gemini's `{error:{code,message,status}}`.
async fn gemini_rewrap(response: Response<Body>) -> Response<Body> {
    let status = response.status();
    if status.is_success() {
        return response;
    }
    let bytes = response
        .into_body()
        .collect()
        .await
        .map(|collected| collected.to_bytes())
        .unwrap_or_default();
    gemini_error(status, &gemini::error_message(&bytes))
}

async fn gemini_reply(call: Call, upstream: reqwest::Response, stream: bool) -> Response<Body> {
    let response_id = format!("resp_{}", call.request_id);
    if stream {
        let converter = GeminiStream::new(&call.requested_model, &response_id);
        return convert_stream(call, upstream, Box::new(converter));
    }
    let parsed = match read_upstream_body(upstream, MAX_RESPONSE_BYTES, call.started).await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "上游返回的不是有效 JSON。".to_string()),
        Err(error) => Err(format!("读取上游响应失败：{error}")),
    };
    match parsed {
        Ok(chat) => {
            let reply = gemini::chat_to_gemini(&chat, &call.requested_model, &response_id);
            call.record(200, chat.get("usage").and_then(Usage::from_chat), None);
            json_response(StatusCode::OK, &reply)
        }
        Err(message) => {
            call.record(502, None, Some(message.clone()));
            gemini_error(StatusCode::BAD_GATEWAY, &message)
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Endpoint {
    Responses,
    Chat,
    Messages,
    Gemini,
}

impl Endpoint {
    fn as_str(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::Chat => "chat",
            Self::Messages => "messages",
            Self::Gemini => "gemini",
        }
    }
}

struct Call {
    shared: Arc<Shared>,
    started: Instant,
    request_id: String,
    logical_request_id: String,
    agent: Option<String>,
    session: Option<String>,
    endpoint: Endpoint,
    provider: String,
    requested_model: String,
    upstream_model: String,
    wire: WireApi,
    stream: bool,
    group: Option<String>,
    context: Option<ContextSize>,
}

impl Call {
    fn record(&self, status: u16, usage: Option<Usage>, error: Option<String>) {
        let usage = usage.unwrap_or_default();
        let record = LedgerRecord {
            ts: chrono::Utc::now().to_rfc3339(),
            request_id: self.request_id.clone(),
            logical_request_id: Some(self.logical_request_id.clone()),
            agent: self.agent.clone(),
            session: self.session.clone(),
            endpoint: self.endpoint.as_str().to_string(),
            provider: self.provider.clone(),
            requested_model: self.requested_model.clone(),
            upstream_model: self.upstream_model.clone(),
            wire: self.wire.as_str().to_string(),
            stream: self.stream,
            status,
            ok: (200..300).contains(&status) && error.is_none(),
            input: usage.input,
            output: usage.output,
            cache_read: usage.cache_read,
            cache_write: usage.cache_write,
            latency_ms: self.started.elapsed().as_millis() as u64,
            error: error.map(|text| text.chars().take(300).collect()),
            group: self.group.clone(),
            member: self
                .group
                .as_ref()
                .map(|_| format!("{}/{}", self.provider, self.upstream_model)),
            context: self.context,
        };
        if let Err(error) = self.shared.ledger.append(&record) {
            log::warn!("gateway ledger: {error}");
        }
    }
}

fn find_provider(shared: &Shared, model: &str) -> Result<(ProviderRecord, String), String> {
    let (provider_id, upstream_model) = model
        .split_once('/')
        .filter(|(id, rest)| !id.is_empty() && !rest.is_empty())
        .ok_or_else(|| format!("模型名「{model}」需要写成 供应商ID/模型。"))?;
    let providers = shared
        .providers
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let provider = providers
        .iter()
        .find(|provider| provider.id == provider_id && provider.enabled)
        .cloned()
        .ok_or_else(|| format!("没有启用的供应商「{provider_id}」。"))?;
    Ok((provider, upstream_model.to_string()))
}

fn upstream_url(provider: &ProviderRecord) -> Result<Url, String> {
    let suffix = match provider.wire {
        WireApi::Responses => "responses",
        WireApi::Chat => "chat/completions",
        WireApi::Anthropic => {
            return Url::parse(&anthropic::messages_url(&provider.base_url))
                .map_err(|_| "供应商接口地址无效。".to_string())
        }
    };
    Url::parse(&format!(
        "{}/{suffix}",
        provider.base_url.trim_end_matches('/')
    ))
    .map_err(|_| "供应商接口地址无效。".to_string())
}

async fn upstream_client(url: &Url) -> Result<reqwest::Client, String> {
    let upstream = policy::resolve(url).await?;
    if upstream.fake_ip {
        log::warn!(
            "gateway: {} resolved to proxy fake-ip {}",
            url.host_str().unwrap_or_default(),
            upstream.addr.ip()
        );
    }
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .resolve(&host, upstream.addr)
        .build()
        .map_err(|error| format!("创建上游连接失败：{error}"))
}

struct RequestCtx {
    gate: Option<Arc<AtomicBool>>,
    request_id: String,
    agent: Option<String>,
    session: Option<String>,
    endpoint: Endpoint,
    requested_model: String,
    stream: bool,
    group: Option<String>,
    /// Client headers an Anthropic-protocol provider should also see.
    anthropic_headers: Vec<(&'static str, String)>,
    /// Prompt composition of the client request, measured before conversion.
    context: Option<ContextSize>,
}

/// One upstream try. `Next` means another group member may be tried: the
/// member was unusable, the connection failed, or upstream sent 5xx/429.
/// Once upstream answers 2xx the reply is committed, so a stream that has
/// started is never switched to another member.
enum Attempt {
    Done {
        response: Response<Body>,
        status: u16,
    },
    Next {
        response: Response<Body>,
        outcome: &'static str,
        status: Option<u16>,
        error: String,
    },
}

fn skip(call: &Call, status: StatusCode, message: String) -> Attempt {
    call.record(status.as_u16(), None, Some(message.clone()));
    Attempt::Next {
        response: error_response(status, &message),
        outcome: "skipped",
        status: Some(status.as_u16()),
        error: message,
    }
}

fn local_minutes() -> u32 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    now.hour() * 60 + now.minute()
}

async fn read_json(request: Request<Incoming>) -> Result<Value, Response<Body>> {
    if request
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .is_some_and(|len| len > MAX_REQUEST_BYTES as u64)
    {
        return Err(error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "请求体超过 32MB。",
        ));
    }
    let collected = tokio::time::timeout(
        REQUEST_READ_TIMEOUT,
        Limited::new(request.into_body(), MAX_REQUEST_BYTES).collect(),
    )
    .await;
    let body = match collected {
        Ok(Ok(collected)) => collected.to_bytes(),
        Ok(Err(_)) => {
            return Err(error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "请求体超过 32MB 或读取失败。",
            ))
        }
        Err(_) => {
            return Err(error_response(
                StatusCode::REQUEST_TIMEOUT,
                "读取请求体超过 30 秒。",
            ))
        }
    };
    serde_json::from_slice::<Value>(&body)
        .map_err(|_| error_response(StatusCode::BAD_REQUEST, "请求体不是有效的 JSON。"))
}

fn request_ctx(
    headers: &HeaderMap,
    endpoint: Endpoint,
    requested_model: String,
    stream: bool,
) -> RequestCtx {
    RequestCtx {
        gate: None,
        request_id: random_id(),
        agent: headers
            .get(USER_AGENT)
            .and_then(|value| value.to_str().ok())
            .and_then(agent_from_user_agent),
        session: header_text(headers, "session_id")
            .or_else(|| header_text(headers, "x-session-id"))
            .or_else(|| header_text(headers, "conversation_id"))
            .or_else(|| header_text(headers, "x-claude-code-session-id")),
        endpoint,
        stream,
        requested_model,
        group: None,
        anthropic_headers: anthropic::FORWARDED_HEADERS
            .into_iter()
            .filter_map(|name| {
                let value = headers.get(name)?.to_str().ok()?;
                Some((name, value.to_string()))
            })
            .collect(),
        context: None,
    }
}

async fn proxy(
    request: Request<Incoming>,
    shared: Arc<Shared>,
    endpoint: Endpoint,
) -> Response<Body> {
    let gate = request.extensions().get::<Arc<AtomicBool>>().cloned();
    let headers = request.headers().clone();
    let payload = match read_json(request).await {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let requested_model = payload
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let stream = payload
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut ctx = request_ctx(&headers, endpoint, requested_model, stream);
    ctx.gate = gate;
    let api = match endpoint {
        Endpoint::Messages => Some(ContextApi::Messages),
        Endpoint::Chat => Some(ContextApi::Chat),
        Endpoint::Responses => Some(ContextApi::Responses),
        Endpoint::Gemini => None,
    };
    ctx.context = api.and_then(|api| context_size::measure(api, &payload));
    route(ctx, &shared, &payload).await
}

/// Structural errors are client errors, independent of a routing member's
/// protocol capabilities, and must never trigger outbound traffic.
fn validate_structure(endpoint: Endpoint, payload: &Value) -> Result<(), String> {
    if !payload.is_object() {
        return Err("请求体必须是 JSON 对象。".into());
    }
    if payload
        .get("stream")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("stream 必须是布尔值。".into());
    }
    if let Some(tools) = payload.get("tools") {
        let tools = tools.as_array().ok_or("tools 必须是数组。")?;
        for tool in tools {
            if !tool.is_object() {
                return Err("工具项必须是对象。".into());
            }
            if endpoint == Endpoint::Responses && !tool.get("type").is_some_and(Value::is_string) {
                return Err("Responses 工具缺少 type。".into());
            }
        }
    }
    let items = if endpoint == Endpoint::Responses {
        match payload.get("input") {
            Some(Value::String(_)) => return Ok(()),
            Some(Value::Array(items)) => items,
            _ => return Err("Responses input 必须是字符串或数组。".into()),
        }
    } else {
        payload
            .get("messages")
            .and_then(Value::as_array)
            .ok_or("请求缺少 messages 数组。")?
    };
    for item in items {
        if !item.is_object() {
            return Err("消息项必须是对象。".into());
        }
        if endpoint == Endpoint::Responses && item.get("type").is_some_and(|v| v != "message") {
            if !item.get("type").is_some_and(Value::is_string) {
                return Err("输入 type 必须是字符串。".into());
            }
            continue;
        }
        let role = item
            .get("role")
            .and_then(Value::as_str)
            .ok_or("消息缺少 role。")?;
        let allowed = if endpoint == Endpoint::Messages {
            &["user", "assistant"][..]
        } else {
            &[
                "user",
                "assistant",
                "system",
                "developer",
                "tool",
                "function",
            ][..]
        };
        if !allowed.contains(&role) {
            return Err("消息 role 不受支持。".into());
        }
        match item.get("content") {
            Some(Value::String(_)) => {}
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    let kind = block
                        .get("type")
                        .and_then(Value::as_str)
                        .ok_or("内容块缺少 type。")?;
                    if matches!(kind, "text" | "input_text" | "output_text")
                        && !block.get("text").is_some_and(Value::is_string)
                    {
                        return Err("文本块缺少 text 字符串。".into());
                    }
                    if kind == "input_image"
                        && !block.get("image_url").is_some_and(Value::is_string)
                    {
                        return Err("图片块缺少 image_url 字符串。".into());
                    }
                    if kind == "image" && endpoint == Endpoint::Messages {
                        let source = block.get("source").ok_or("图片块缺少 source。")?;
                        let valid = match source.get("type").and_then(Value::as_str) {
                            Some("url") => source.get("url").is_some_and(Value::is_string),
                            Some("base64") => {
                                source.get("media_type").is_some_and(Value::is_string)
                                    && source.get("data").is_some_and(Value::is_string)
                            }
                            _ => false,
                        };
                        if !valid {
                            return Err("图片 source 结构无效。".into());
                        }
                    }
                }
            }
            Some(Value::Null)
                if role == "assistant" && item.get("tool_calls").is_some_and(Value::is_array) => {}
            _ => return Err("消息 content 必须是字符串或数组。".into()),
        }
    }
    Ok(())
}

/// One model or each `group/<id>` member in plan order.
async fn route(mut ctx: RequestCtx, shared: &Arc<Shared>, payload: &Value) -> Response<Body> {
    if let Err(message) = validate_structure(ctx.endpoint, payload) {
        return error_response(StatusCode::BAD_REQUEST, &message);
    }
    let Some(group_id) = ctx.requested_model.strip_prefix(GROUP_PREFIX) else {
        let member = ctx.requested_model.clone();
        return match attempt(&ctx, shared, &member, payload).await {
            Attempt::Done { response, .. } | Attempt::Next { response, .. } => response,
        };
    };
    let Some(group) = shared.router.enabled_group(group_id) else {
        return error_response(
            StatusCode::NOT_FOUND,
            &format!("没有启用的路由组「{group_id}」。"),
        );
    };
    ctx.group = Some(group.id.clone());
    let features = Features::extract(payload, ctx.agent.as_deref(), local_minutes());
    // Header sessions are recorded; a body-derived key only pins routing.
    let affinity_key = ctx.session.clone().or_else(|| body_session(payload));
    let plan = shared
        .router
        .plan(&group, &features, affinity_key.as_deref());
    let mut attempts = Vec::new();
    let mut chosen = None;
    let mut last = None;
    for member in &plan.candidates {
        match attempt(&ctx, shared, member, payload).await {
            Attempt::Done { response, status } => {
                let ok = (200..300).contains(&status);
                attempts.push(RouteAttempt {
                    member: member.clone(),
                    outcome: if ok { "ok" } else { "rejected" },
                    status: Some(status),
                    error: None,
                });
                if ok {
                    shared.router.recover(member);
                    chosen = Some(member.clone());
                    if !plan.is_rule() {
                        shared
                            .router
                            .remember(&group, affinity_key.as_deref(), member);
                    }
                }
                last = Some(response);
                break;
            }
            Attempt::Next {
                response,
                outcome,
                status,
                error,
            } => {
                if outcome == "failed" {
                    shared.router.cool(member);
                }
                attempts.push(RouteAttempt {
                    member: member.clone(),
                    outcome,
                    status,
                    error: Some(error.chars().take(200).collect()),
                });
                last = Some(response);
            }
        }
    }
    let trace = build_trace(&group, &plan, &attempts);
    shared.router.record(RouteDecision {
        ts: chrono::Utc::now().to_rfc3339(),
        request_id: ctx.request_id.clone(),
        group: group.id.clone(),
        session: ctx.session.clone(),
        reason: plan.reason,
        detail: plan.detail,
        chosen,
        attempts,
        trace,
    });
    last.unwrap_or_else(|| error_response(StatusCode::SERVICE_UNAVAILABLE, "路由组没有可用成员。"))
}

async fn attempt(
    ctx: &RequestCtx,
    shared: &Arc<Shared>,
    member: &str,
    original: &Value,
) -> Attempt {
    let (provider, upstream_model) = match find_provider(shared, member) {
        Ok(found) => found,
        Err(message) => {
            return Attempt::Next {
                response: error_response(StatusCode::NOT_FOUND, &message),
                outcome: "skipped",
                status: None,
                error: message,
            }
        }
    };
    let call = Call {
        shared: shared.clone(),
        started: Instant::now(),
        request_id: random_id(),
        logical_request_id: ctx.request_id.clone(),
        agent: ctx.agent.clone(),
        session: ctx.session.clone(),
        endpoint: ctx.endpoint,
        provider: provider.id.clone(),
        requested_model: ctx.requested_model.clone(),
        upstream_model: upstream_model.clone(),
        wire: provider.wire,
        stream: ctx.stream,
        group: ctx.group.clone(),
        context: ctx.context,
    };

    let mut payload = original.clone();
    let conversion = match (ctx.endpoint, provider.wire) {
        (Endpoint::Responses, WireApi::Responses)
        | (Endpoint::Chat, WireApi::Chat)
        | (Endpoint::Messages, WireApi::Anthropic) => {
            payload["model"] = json!(upstream_model);
            Conversion::None
        }
        (Endpoint::Responses, WireApi::Chat) => {
            match responses_to_chat(&payload, &upstream_model, ctx.stream) {
                Ok(converted) => {
                    payload = converted.body;
                    Conversion::ResponsesViaChat(converted.custom_tools)
                }
                Err(message) => return skip(&call, StatusCode::BAD_REQUEST, message),
            }
        }
        (Endpoint::Messages, WireApi::Chat) => {
            match anthropic::messages_to_chat(&payload, &upstream_model, ctx.stream) {
                Ok(converted) => {
                    payload = converted;
                    Conversion::MessagesViaChat
                }
                Err(message) => return skip(&call, StatusCode::BAD_REQUEST, message),
            }
        }
        (Endpoint::Chat, WireApi::Responses) => {
            return skip(
                &call,
                StatusCode::BAD_REQUEST,
                "这个供应商只提供 Responses 接口，请改用 /v1/responses。".to_string(),
            );
        }
        (Endpoint::Messages, WireApi::Responses) => {
            return skip(
                &call,
                StatusCode::BAD_REQUEST,
                "这个供应商只提供 Responses 接口，不能服务 Anthropic Messages 请求，请换用 Chat 或 Anthropic 协议的供应商。".to_string(),
            );
        }
        (Endpoint::Responses | Endpoint::Chat, WireApi::Anthropic) => {
            return skip(
                &call,
                StatusCode::BAD_REQUEST,
                "这个供应商只提供 Anthropic Messages 接口，请改用 /v1/messages（如 Claude Code），或换用 Chat 协议的供应商。".to_string(),
            );
        }
        (Endpoint::Gemini, WireApi::Chat) => {
            payload["model"] = json!(upstream_model);
            Conversion::GeminiViaChat
        }
        (Endpoint::Gemini, WireApi::Responses | WireApi::Anthropic) => {
            let message = format!(
                "Gemini 接口只能转发到 Chat 协议的供应商，「{}」不是 Chat 协议。",
                provider.name
            );
            return skip(&call, StatusCode::BAD_REQUEST, message);
        }
    };

    if let Err(message) = validate_auth_mode(&provider) {
        return skip(&call, StatusCode::BAD_REQUEST, message);
    }
    let key = if provider.auth_mode == AuthMode::None {
        Ok(Some(String::new()))
    } else {
        let secrets = shared.secrets.clone();
        let account = provider_account(&provider.id);
        let permit = match SECRET_SLOTS.try_acquire() {
            Ok(permit) => permit,
            Err(_) => {
                return skip(
                    &call,
                    StatusCode::SERVICE_UNAVAILABLE,
                    "凭据读取繁忙，请稍后重试。".into(),
                )
            }
        };
        // A timed-out OS keychain call keeps its own slot until its blocking
        // thread exits, so cancellation cannot create an unbounded work queue.
        tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                secrets.get(&account)
            }),
        )
        .await
        .unwrap_or_else(|_| Ok(Err("读取钥匙串超过 15 秒。".into())))
        .unwrap_or_else(|_| Err("读取钥匙串失败。".to_string()))
    };
    let key = match key {
        Ok(Some(key)) => key,
        Ok(None) => {
            let message = format!("供应商「{}」还没有设置 API key。", provider.name);
            return skip(&call, StatusCode::UNAUTHORIZED, message);
        }
        Err(message) => return skip(&call, StatusCode::INTERNAL_SERVER_ERROR, message),
    };

    let presented_key = key.clone();
    let sent = tokio::time::timeout(UPSTREAM_HEADERS_TIMEOUT, async {
        let url = upstream_url(&provider)?;
        let client = upstream_client(&url).await?;
        if ctx
            .gate
            .as_ref()
            .is_some_and(|gate| !gate.load(Ordering::SeqCst))
        {
            return Err("网关已停止，未连接上游。".into());
        }
        let mut builder = client.post(url);
        if provider.wire == WireApi::Anthropic {
            if provider.auth_mode == AuthMode::Key {
                builder = builder.header("x-api-key", key);
            }
            for (name, value) in &ctx.anthropic_headers {
                builder = builder.header(*name, value);
            }
            if !ctx
                .anthropic_headers
                .iter()
                .any(|(name, _)| *name == "anthropic-version")
            {
                builder = builder.header("anthropic-version", anthropic::DEFAULT_VERSION);
            }
        } else if provider.auth_mode == AuthMode::Key {
            builder = builder.bearer_auth(key);
        }
        builder
            .header(CONTENT_TYPE, "application/json")
            .body(payload.to_string())
            .send()
            .await
            .map_err(|error| format!("连接上游失败：{}", error.without_url()))
    })
    .await
    .unwrap_or_else(|_| Err("等待上游响应头超过 60 秒。".to_string()));
    let upstream = match sent {
        Ok(response) => response,
        Err(message) => {
            call.record(502, None, Some(message.clone()));
            return Attempt::Next {
                response: error_response(StatusCode::BAD_GATEWAY, &message),
                outcome: "failed",
                status: None,
                error: message,
            };
        }
    };

    let status = upstream.status();
    if !status.is_success() {
        let text = redact_key(&read_limited(upstream).await, &presented_key);
        let message = format!(
            "上游返回 {status}：{}",
            text.chars().take(200).collect::<String>()
        );
        let usage = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| usage_of(call.wire, &value, None));
        call.record(status.as_u16(), usage, Some(message.clone()));
        let code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let response = Response::builder()
            .status(code)
            .header(CONTENT_TYPE, "application/json")
            .body(full(text))
            .expect("static response parts are valid");
        return if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
            Attempt::Next {
                response,
                outcome: "failed",
                status: Some(status.as_u16()),
                error: message,
            }
        } else {
            Attempt::Done {
                response,
                status: status.as_u16(),
            }
        };
    }

    let response = match (conversion, ctx.stream) {
        (Conversion::GeminiViaChat, stream) => gemini_reply(call, upstream, stream).await,
        (Conversion::None, false) => passthrough_whole(call, upstream).await,
        (Conversion::None, true) => passthrough_stream(call, upstream),
        (conversion, false) => convert_whole(call, upstream, conversion).await,
        (conversion, true) => {
            let converter = chat_stream(&call, conversion);
            convert_stream(call, upstream, converter)
        }
    };
    let status = response.status().as_u16();
    Attempt::Done { response, status }
}

async fn read_upstream_body(
    response: reqwest::Response,
    max_bytes: usize,
    started: Instant,
) -> Result<Bytes, String> {
    if response
        .content_length()
        .is_some_and(|len| len > max_bytes as u64)
    {
        return Err(format!("上游响应超过 {max_bytes} 字节限制。"));
    }
    let deadline = tokio::time::Instant::from_std(started + WHOLE_RESPONSE_TIMEOUT);
    tokio::time::timeout_at(deadline, async move {
        let mut collected = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| error.without_url().to_string())?;
            if chunk.len() > max_bytes.saturating_sub(collected.len()) {
                return Err(format!("上游响应超过 {max_bytes} 字节限制。"));
            }
            collected.extend_from_slice(&chunk);
        }
        Ok(Bytes::from(collected))
    })
    .await
    .unwrap_or_else(|_| Err("上游非流式请求超过 300 秒总时限。".into()))
}

/// Some upstreams echo the presented key in their error text, which then
/// reaches the agent and the request ledger.
fn redact_key(text: &str, key: &str) -> String {
    let key = key.trim();
    if key.len() >= 8 {
        text.replace(key, "[已隐去 API key]")
    } else {
        text.to_string()
    }
}

async fn read_limited(response: reqwest::Response) -> String {
    match tokio::time::timeout(
        REQUEST_READ_TIMEOUT,
        read_upstream_body(response, MAX_ERROR_BYTES, Instant::now()),
    )
    .await
    {
        Ok(Ok(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
        Ok(Err(message)) => json!({"error":{"message": message}}).to_string(),
        Err(_) => json!({"error":{"message":"读取上游错误响应超过 30 秒。"}}).to_string(),
    }
}

/// Usage found in one reply or stream event, folded into what was seen before.
fn usage_of(wire: WireApi, value: &Value, previous: Option<Usage>) -> Option<Usage> {
    match wire {
        WireApi::Responses => value
            .get("usage")
            .or_else(|| value.pointer("/response/usage"))
            .and_then(Usage::from_responses)
            .or(previous),
        WireApi::Chat => value.get("usage").and_then(Usage::from_chat).or(previous),
        WireApi::Anthropic => match value
            .get("usage")
            .or_else(|| value.pointer("/message/usage"))
        {
            Some(usage) => Usage::absorb_anthropic(previous, usage),
            None => previous,
        },
    }
}

async fn passthrough_whole(call: Call, upstream: reqwest::Response) -> Response<Body> {
    match read_upstream_body(upstream, MAX_RESPONSE_BYTES, call.started).await {
        Ok(bytes) => {
            let usage = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|value| usage_of(call.wire, &value, None));
            call.record(200, usage, None);
            Response::builder()
                .header(CONTENT_TYPE, "application/json")
                .body(full(bytes))
                .expect("static response parts are valid")
        }
        Err(error) => {
            let message = format!("读取上游响应失败：{error}");
            call.record(502, None, Some(message.clone()));
            error_response(StatusCode::BAD_GATEWAY, &message)
        }
    }
}

/// How the client's protocol differs from the provider's.
enum Conversion {
    None,
    ResponsesViaChat(std::collections::HashSet<String>),
    MessagesViaChat,
    GeminiViaChat,
}

async fn convert_whole(
    call: Call,
    upstream: reqwest::Response,
    conversion: Conversion,
) -> Response<Body> {
    let parsed = match read_upstream_body(upstream, MAX_RESPONSE_BYTES, call.started).await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "上游返回的不是有效 JSON。".to_string()),
        Err(error) => Err(format!("读取上游响应失败：{error}")),
    };
    match parsed {
        Ok(chat) => {
            let response = match &conversion {
                Conversion::MessagesViaChat => anthropic::chat_to_message(
                    &chat,
                    &format!("msg_{}", call.request_id),
                    &call.requested_model,
                ),
                Conversion::ResponsesViaChat(custom_tools) => chat_to_response(
                    &chat,
                    &format!("resp_{}", call.request_id),
                    &call.requested_model,
                    chrono::Utc::now().timestamp(),
                    custom_tools,
                ),
                Conversion::None | Conversion::GeminiViaChat => chat.clone(),
            };
            call.record(200, chat.get("usage").and_then(Usage::from_chat), None);
            json_response(StatusCode::OK, &response)
        }
        Err(message) => {
            call.record(502, None, Some(message.clone()));
            error_response(StatusCode::BAD_GATEWAY, &message)
        }
    }
}

fn sse_response(receiver: mpsc::Receiver<Bytes>) -> Response<Body> {
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|chunk| (Ok::<_, std::io::Error>(Frame::data(chunk)), receiver))
    });
    Response::builder()
        .header(CONTENT_TYPE, "text/event-stream")
        .header("cache-control", "no-cache")
        .body(StreamBody::new(stream).boxed_unsync())
        .expect("static response parts are valid")
}

async fn next_chunk<S>(
    stream: &mut S,
    sender: &mpsc::Sender<Bytes>,
) -> Result<Option<Bytes>, String>
where
    S: futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
{
    let next = tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next());
    let closed = sender.closed();
    futures_util::pin_mut!(next, closed);
    match futures_util::future::select(next, closed).await {
        futures_util::future::Either::Right(_) => Err("客户端提前断开。".into()),
        futures_util::future::Either::Left((Err(_), _)) => {
            Err("上游 SSE 连续 120 秒没有数据。".into())
        }
        futures_util::future::Either::Left((Ok(Some(Err(error))), _)) => {
            Err(format!("上游流中断：{}", error.without_url()))
        }
        futures_util::future::Either::Left((Ok(Some(Ok(bytes))), _)) => Ok(Some(bytes)),
        futures_util::future::Either::Left((Ok(None), _)) => Ok(None),
    }
}

async fn send_chunk(sender: &mpsc::Sender<Bytes>, bytes: Bytes) -> Result<(), String> {
    match tokio::time::timeout(CLIENT_SEND_TIMEOUT, sender.send(bytes)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err("客户端提前断开。".into()),
        Err(_) => Err("客户端连续 30 秒未读取响应。".into()),
    }
}

fn stream_error(endpoint: Endpoint, message: &str) -> String {
    match endpoint {
        Endpoint::Messages => anthropic::error_event(message),
        Endpoint::Responses => format!(
            "event: response.failed\ndata: {}\n\n",
            json!({"type":"response.failed", "response":{"status":"failed","error":{"message":message}}})
        ),
        _ => format!(
            "data: {}\n\n",
            json!({"error":{"message":message,"type":"tokenledger_gateway_error"}})
        ),
    }
}

fn stream_terminal(wire: WireApi, data: &str) -> bool {
    if data == "[DONE]" {
        return true;
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return false;
    };
    matches!(
        (wire, value.get("type").and_then(Value::as_str)),
        (
            WireApi::Responses,
            Some("response.completed" | "response.failed" | "response.incomplete")
        ) | (WireApi::Anthropic, Some("message_stop"))
    )
}

/// Protocols commonly include `error: null` on normal lifecycle events.
/// Only a non-null value signals failure; a null top-level field must not
/// mask a non-null nested Responses error.
fn upstream_stream_error(value: &Value) -> Option<String> {
    value
        .get("error")
        .filter(|error| !error.is_null())
        .or_else(|| {
            value
                .pointer("/response/error")
                .filter(|error| !error.is_null())
        })
        .map(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("上游返回流式错误。")
                .to_string()
        })
}

fn passthrough_stream(call: Call, upstream: reqwest::Response) -> Response<Body> {
    let (sender, receiver) = mpsc::channel::<Bytes>(STREAM_QUEUE);
    tokio::spawn(async move {
        let mut lines = SseLines::default();
        let mut usage = None;
        let mut error = None;
        let mut terminal = false;
        let mut total = 0usize;
        let mut stream = upstream.bytes_stream();
        loop {
            let chunk = match next_chunk(&mut stream, &sender).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(message) => {
                    error = Some(message);
                    break;
                }
            };
            if chunk.len() > MAX_STREAM_BYTES.saturating_sub(total) {
                error = Some("上游 SSE 总响应超过 64MiB。".into());
                break;
            }
            total += chunk.len();
            let complete = match lines.push(&chunk) {
                Ok(lines) => lines,
                Err(message) => {
                    error = Some(message);
                    break;
                }
            };
            for line in complete {
                if let Some(data) = sse_data(&line) {
                    terminal |= stream_terminal(call.wire, data);
                    if let Ok(value) = serde_json::from_str::<Value>(data) {
                        usage = usage_of(call.wire, &value, usage);
                        if let Some(message) = upstream_stream_error(&value) {
                            error = Some(message);
                        }
                    }
                }
            }
            if let Err(message) = send_chunk(&sender, chunk).await {
                error = Some(message);
                break;
            }
            if terminal || error.is_some() {
                break;
            }
        }
        if error.is_none() {
            if let Some(line) = lines.finish() {
                if let Some(data) = sse_data(&line) {
                    terminal |= stream_terminal(call.wire, data);
                    if let Ok(value) = serde_json::from_str::<Value>(data) {
                        usage = usage_of(call.wire, &value, usage);
                        error = upstream_stream_error(&value);
                    }
                }
            }
            if !terminal && error.is_none() {
                error = Some("上游 SSE 在结束事件前中断。".into());
            }
        }
        if let Some(message) = &error {
            let _ = send_chunk(&sender, Bytes::from(stream_error(call.endpoint, message))).await;
        }
        call.record(200, usage, error);
    });
    sse_response(receiver)
}

impl ChatStream for GeminiStream {
    fn start(&mut self) -> Vec<String> {
        Vec::new()
    }
    fn push_chunk(&mut self, chunk: &Value) -> Vec<String> {
        GeminiStream::push_chunk(self, chunk)
    }
    fn finish(&mut self) -> Vec<String> {
        GeminiStream::finish(self)
    }
    fn fail(&mut self, message: &str) -> Vec<String> {
        GeminiStream::fail(self, message)
    }
    fn usage(&self) -> Option<Usage> {
        GeminiStream::usage(self)
    }
}

fn chat_stream(call: &Call, conversion: Conversion) -> Box<dyn ChatStream> {
    match conversion {
        Conversion::MessagesViaChat => Box::new(anthropic::MessageStream::new(
            &format!("msg_{}", call.request_id),
            &call.requested_model,
        )),
        Conversion::ResponsesViaChat(custom_tools) => Box::new(StreamConverter::new(
            &format!("resp_{}", call.request_id),
            &call.requested_model,
            chrono::Utc::now().timestamp(),
            custom_tools,
        )),
        Conversion::GeminiViaChat => Box::new(GeminiStream::new(
            &call.requested_model,
            &format!("resp_{}", call.request_id),
        )),
        Conversion::None => unreachable!("passthrough streams are not converted"),
    }
}

async fn send_events(
    sender: &mpsc::Sender<Bytes>,
    events: Vec<String>,
    emitted: &mut usize,
) -> Result<(), String> {
    for event in events {
        if event.len() > MAX_CONVERTED_EVENT_BYTES
            || event.len() > MAX_STREAM_BYTES.saturating_sub(*emitted)
        {
            return Err("转换后的 SSE 事件超过 8MiB 或总响应超过 64MiB。".into());
        }
        *emitted += event.len();
        send_chunk(sender, Bytes::from(event)).await?;
    }
    Ok(())
}

fn convert_stream(
    call: Call,
    upstream: reqwest::Response,
    mut converter: Box<dyn ChatStream>,
) -> Response<Body> {
    let (sender, receiver) = mpsc::channel::<Bytes>(STREAM_QUEUE);
    tokio::spawn(async move {
        let mut lines = SseLines::default();
        let mut emitted = 0usize;
        // Bound the aggregate input into converter state before allocating it.
        // Decoded text/tool arguments cannot exceed the JSON wire bytes.
        let mut converted = 0usize;
        let mut terminal = false;
        let mut observed_usage = None;
        let mut error = send_events(&sender, converter.start(), &mut emitted)
            .await
            .err();
        let mut stream = upstream.bytes_stream();
        while error.is_none() && !terminal {
            let chunk = match next_chunk(&mut stream, &sender).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(message) => {
                    error = Some(message);
                    break;
                }
            };
            if chunk.len() > MAX_CONVERSION_BYTES.saturating_sub(converted) {
                error = Some("SSE 转换累计输入超过 8MiB。".into());
                break;
            }
            converted += chunk.len();
            let complete = match lines.push(&chunk) {
                Ok(lines) => lines,
                Err(message) => {
                    error = Some(message);
                    break;
                }
            };
            for line in complete {
                let Some(data) = sse_data(&line) else {
                    continue;
                };
                if data == "[DONE]" {
                    terminal = true;
                    break;
                }
                let value = match serde_json::from_str::<Value>(data) {
                    Ok(value) => value,
                    Err(_) => {
                        error = Some("上游 SSE 数据不是有效 JSON。".into());
                        break;
                    }
                };
                observed_usage = usage_of(WireApi::Chat, &value, observed_usage);
                if let Some(message) = upstream_stream_error(&value) {
                    error = Some(message);
                    break;
                }
                let events = converter.push_chunk(&value);
                if let Err(message) = send_events(&sender, events, &mut emitted).await {
                    error = Some(message);
                    break;
                }
            }
        }
        if error.is_none() && !terminal {
            if let Some(line) = lines.finish() {
                if let Some(data) = sse_data(&line) {
                    if data == "[DONE]" {
                        terminal = true;
                    } else if let Ok(value) = serde_json::from_str::<Value>(data) {
                        observed_usage = usage_of(WireApi::Chat, &value, observed_usage);
                        if let Some(message) = upstream_stream_error(&value) {
                            error = Some(message);
                        } else {
                            let events = converter.push_chunk(&value);
                            error = send_events(&sender, events, &mut emitted).await.err();
                        }
                    }
                }
            }
            if !terminal && error.is_none() {
                error = Some("上游 SSE 在结束事件前中断。".into());
            }
        }
        if error.is_none() {
            let events = converter.finish();
            error = send_events(&sender, events, &mut emitted).await.err();
        }
        if let Some(message) = &error {
            let events = converter.fail(message);
            let _ = send_events(&sender, events, &mut emitted).await;
        }
        call.record(200, observed_usage.or_else(|| converter.usage()), error);
    });
    sse_response(receiver)
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
