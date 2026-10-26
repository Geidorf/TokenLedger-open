use super::super::store::{MemorySecrets, SecretStore};
use super::*;
use std::io::{BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Upstream {
    url: String,
    hits: Arc<AtomicUsize>,
    requests: Arc<std::sync::Mutex<Vec<Value>>>,
    auth_headers: Arc<std::sync::Mutex<Vec<Option<String>>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Upstream {
    fn new(status: u16, body: Value) -> Self {
        Self::responses(vec![(status, body)])
    }
    fn responses(responses: Vec<(u16, Value)>) -> Self {
        Self::raw_sequence(
            responses
                .into_iter()
                .map(|(status, body)| {
                    let body = body.to_string();
                    vec![(Duration::ZERO, format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes())]
                })
                .collect(),
        )
    }
    fn raw(packets: Vec<(Duration, Vec<u8>)>) -> Self {
        Self::raw_sequence(vec![packets])
    }
    fn raw_sequence(responses: Vec<Vec<(Duration, Vec<u8>)>>) -> Self {
        assert!(!responses.is_empty());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = requests.clone();
        let auth_headers = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured_auth = auth_headers.clone();
        let (count, stopped) = (hits.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                if let Ok((mut socket, _)) = listener.accept() {
                    socket.set_nonblocking(false).unwrap();
                    socket.set_nodelay(true).unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut reader = std::io::BufReader::new(socket.try_clone().unwrap());
                    let mut len = 0;
                    let mut authorization = None;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        if line.to_ascii_lowercase().starts_with("authorization:")
                            || line.to_ascii_lowercase().starts_with("x-api-key:")
                        {
                            authorization = Some(line.trim().to_string());
                        }
                        if let Some(value) =
                            line.to_ascii_lowercase().strip_prefix("content-length:")
                        {
                            len = value.trim().parse().unwrap();
                        }
                    }
                    let mut bytes = vec![0; len];
                    let _ = reader.read_exact(&mut bytes);
                    let response_index = count.fetch_add(1, Ordering::SeqCst);
                    captured_auth.lock().unwrap().push(authorization);
                    if let Ok(value) = serde_json::from_slice(&bytes) {
                        captured.lock().unwrap().push(value);
                    }
                    for (delay, packet) in &responses[response_index.min(responses.len() - 1)] {
                        std::thread::sleep(*delay);
                        if socket.write_all(packet).is_err() {
                            break;
                        }
                    }
                } else {
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
        });
        Self {
            url,
            hits,
            requests,
            auth_headers,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Upstream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
static TEST_ID: AtomicUsize = AtomicUsize::new(0);
fn make_shared(urls: &[(&str, String, WireApi)]) -> (Arc<Shared>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "tl-gw-http-{}-{}",
        std::process::id(),
        TEST_ID.fetch_add(1, Ordering::SeqCst)
    ));
    let secrets = Arc::new(MemorySecrets::default());
    let providers: Vec<_> = urls
        .iter()
        .map(|(id, url, wire)| {
            secrets.set(&provider_account(id), "fixture-key").unwrap();
            ProviderRecord {
                id: (*id).into(),
                name: (*id).into(),
                base_url: url.clone(),
                wire: *wire,
                auth_mode: AuthMode::Key,
                models: vec!["m".into()],
                enabled: true,
            }
        })
        .collect();
    let router = super::super::routing::Router::new(&dir);
    router.upsert(serde_json::from_value(json!({"id":"g", "name":"g", "strategy":"failover", "members":urls.iter().map(|(id,_,_)|format!("{id}/m")).collect::<Vec<_>>()})).unwrap(), &urls.iter().map(|(id,_,_)|id.to_string()).collect::<Vec<_>>()).unwrap();
    (
        Arc::new(Shared {
            providers: std::sync::RwLock::new(providers),
            secrets,
            ledger: super::super::ledger::Ledger::new(&dir),
            router,
            routing_health: super::super::routing_health::RoutingHealth::default(),
            prober: Arc::new(super::super::probe::Prober::new(&dir)),
        }),
        dir,
    )
}
fn run(future: impl std::future::Future<Output = ()>) {
    let _lock = HTTP_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(20), future)
                .await
                .expect("bounded HTTP test");
        });
}

#[test]
fn real_http_routing_skips_recent_failures_and_success_restores_the_member() {
    run(async {
        let success = json!({"choices":[{"message":{"content":"ok"}}]});
        let first = Upstream::responses(vec![
            (503, json!({"error":"unavailable"})),
            (503, json!({"error":"unavailable"})),
            (503, json!({"error":"unavailable"})),
            (200, success.clone()),
        ]);
        let second = Upstream::new(200, success);
        let (shared, dir) = make_shared(&[
            ("a", first.url.clone(), WireApi::Chat),
            ("b", second.url.clone(), WireApi::Chat),
        ]);
        let mut group = shared.router.enabled_group("g").unwrap();
        group.session_ttl_secs = 0;
        shared
            .router
            .upsert(group, &["a".into(), "b".into()])
            .unwrap();
        let payload = json!({"messages":[{"role":"user","content":"hi"}]});
        for _ in 0..3 {
            let response = route(
                request_ctx(&HeaderMap::new(), Endpoint::Chat, "a/m".into(), false),
                &shared,
                &payload,
            )
            .await;
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            response.into_body().collect().await.unwrap();
        }
        let response = route(
            request_ctx(&HeaderMap::new(), Endpoint::Chat, "group/g".into(), false),
            &shared,
            &payload,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        response.into_body().collect().await.unwrap();
        assert_eq!(first.hits.load(Ordering::SeqCst), 3);
        assert_eq!(second.hits.load(Ordering::SeqCst), 1);
        let decision = &shared.router.recent(1)[0];
        assert_eq!(decision.attempts.len(), 1);
        assert_eq!(decision.chosen.as_deref(), Some("b/m"));
        let excluded = decision
            .trace
            .iter()
            .find(|item| item.member == "a/m")
            .unwrap();
        assert_eq!(excluded.verdict, "excluded");
        assert!(excluded.reasons.contains(&"unhealthy"));

        let response = route(
            request_ctx(&HeaderMap::new(), Endpoint::Chat, "a/m".into(), false),
            &shared,
            &payload,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        response.into_body().collect().await.unwrap();
        let response = route(
            request_ctx(&HeaderMap::new(), Endpoint::Chat, "group/g".into(), false),
            &shared,
            &payload,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        response.into_body().collect().await.unwrap();
        assert_eq!(first.hits.load(Ordering::SeqCst), 5);
        assert_eq!(second.hits.load(Ordering::SeqCst), 1);
        assert_eq!(shared.router.recent(1)[0].chosen.as_deref(), Some("a/m"));
        std::fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn real_http_health_gate_respects_manual_selection_and_all_failed_fallback() {
    run(async {
        let success = json!({"choices":[{"message":{"content":"ok"}}]});
        let first = Upstream::new(200, success.clone());
        let second = Upstream::new(200, success);
        let (shared, dir) = make_shared(&[
            ("a", first.url.clone(), WireApi::Chat),
            ("b", second.url.clone(), WireApi::Chat),
        ]);
        let failed_probe = || super::super::probe::ProbeResult {
            ts: chrono::Utc::now().to_rfc3339(),
            ok: false,
            status: Some(503),
            latency_ms: 1,
            code: "upstream_failed",
            error: None,
        };
        let generation = shared.prober.generation();
        shared.prober.record(generation, "a", failed_probe());
        let payload = json!({"messages":[{"role":"user","content":"hi"}]});
        let response = route(
            request_ctx(&HeaderMap::new(), Endpoint::Chat, "group/g".into(), false),
            &shared,
            &payload,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        response.into_body().collect().await.unwrap();
        assert_eq!(first.hits.load(Ordering::SeqCst), 0);
        assert_eq!(second.hits.load(Ordering::SeqCst), 1);

        shared
            .router
            .upsert(
                serde_json::from_value(json!({
                    "id":"g", "name":"g", "strategy":"manual", "members":["a/m","b/m"],
                    "manualMember":"a/m", "sessionTtlSecs":0
                }))
                .unwrap(),
                &["a".into(), "b".into()],
            )
            .unwrap();
        let response = route(
            request_ctx(&HeaderMap::new(), Endpoint::Chat, "group/g".into(), false),
            &shared,
            &payload,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        response.into_body().collect().await.unwrap();
        assert_eq!(first.hits.load(Ordering::SeqCst), 1);
        assert_eq!(shared.router.recent(1)[0].chosen.as_deref(), Some("a/m"));

        shared.prober.record(generation, "a", failed_probe());
        shared.prober.record(generation, "b", failed_probe());
        shared
            .router
            .upsert(
                serde_json::from_value(json!({
                    "id":"g", "name":"g", "strategy":"failover", "members":["a/m","b/m"],
                    "sessionTtlSecs":0
                }))
                .unwrap(),
                &["a".into(), "b".into()],
            )
            .unwrap();
        let response = route(
            request_ctx(&HeaderMap::new(), Endpoint::Chat, "group/g".into(), false),
            &shared,
            &payload,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        response.into_body().collect().await.unwrap();
        assert_eq!(first.hits.load(Ordering::SeqCst), 2);
        assert_eq!(second.hits.load(Ordering::SeqCst), 1);
        assert!(shared.router.recent(1)[0]
            .trace
            .iter()
            .all(|item| item.verdict != "excluded"));
        std::fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn real_http_failover_records_distinct_attempts_and_reported_failure_usage() {
    run(async {
        for (first_status, first_tokens, final_status, expected_hits) in [
            (503, 0, 200, 1),
            (429, 3, 200, 1),
            (503, 0, 503, 1),
            (400, 0, 200, 0),
        ] {
            let first = Upstream::new(
                first_status,
                json!({"error":"fixture", "usage":{"prompt_tokens":first_tokens,"completion_tokens":0}}),
            );
            let second = Upstream::new(
                final_status,
                json!({"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}),
            );
            let (shared, dir) = make_shared(&[
                ("a", first.url.clone(), WireApi::Chat),
                ("b", second.url.clone(), WireApi::Chat),
            ]);
            let ctx = request_ctx(&HeaderMap::new(), Endpoint::Chat, "group/g".into(), false);
            let response = route(
                ctx,
                &shared,
                &json!({"model":"group/g","messages":[{"role":"user","content":"hi"}]}),
            )
            .await;
            assert_eq!(
                response.status().as_u16(),
                if expected_hits == 0 {
                    first_status
                } else {
                    final_status
                }
            );
            assert_eq!(first.hits.load(Ordering::SeqCst), 1);
            assert_eq!(second.hits.load(Ordering::SeqCst), expected_hits);
            let records = shared.ledger.recent(10).unwrap();
            assert_eq!(records.len(), 1 + expected_hits);
            if records.len() == 2 {
                assert_ne!(records[0].request_id, records[1].request_id);
                assert_eq!(records[0].logical_request_id, records[1].logical_request_id);
            }
            assert_eq!(records.last().unwrap().input, first_tokens);
            assert_eq!(shared.router.recent(1)[0].attempts.len(), 1 + expected_hits);
            // The decision outlives a restart, keyed by the logical request id.
            let logical = records[0].logical_request_id.clone().unwrap();
            let stored = super::super::request_log::read_decisions(&dir);
            assert_eq!(stored[&logical].attempts.len(), 1 + expected_hits);
            std::fs::remove_dir_all(dir).unwrap();
        }
    });
}

#[test]
fn unsupported_conversion_never_sends_and_native_group_member_preserves_semantics() {
    run(async {
        let chat = Upstream::new(200, json!({"choices":[{"message":{"content":"ok"}}]}));
        let (shared, dir) = make_shared(&[("a", chat.url.clone(), WireApi::Chat)]);
        let cases = [
            (
                Endpoint::Responses,
                json!({"input":"hi","tools":[{"type":"web_search"}]}),
            ),
            (
                Endpoint::Responses,
                json!({"input":[{"type":"message","role":"user","content":[{"type":"input_file","file_id":"f"}]}]}),
            ),
            (
                Endpoint::Responses,
                json!({"input":[{"type":"unknown","text":"keep me"}]}),
            ),
            (
                Endpoint::Responses,
                json!({"input":[{"type":"message","role":"user","content":[{"type":"input_image"}]}]}),
            ),
            (
                Endpoint::Messages,
                json!({"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"web_search_20250305","name":"web_search"}]}),
            ),
            (
                Endpoint::Messages,
                json!({"messages":[{"role":"user","content":[{"type":"document","source":{"type":"text","data":"keep me"}}]}]}),
            ),
            (
                Endpoint::Messages,
                json!({"messages":[{"role":"user","content":[{"type":"unknown","text":"keep me"}]}]}),
            ),
            (
                Endpoint::Messages,
                json!({"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":[{"type":"image","source":{"type":"url","url":"https://example.com/a.png"}}]}]}]}),
            ),
        ];
        for (endpoint, payload) in &cases {
            let response = route(
                request_ctx(&HeaderMap::new(), *endpoint, "a/m".into(), false),
                &shared,
                payload,
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        assert_eq!(chat.hits.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(dir).unwrap();
        let native = Upstream::new(
            200,
            json!({"output":[],"usage":{"input_tokens":2,"output_tokens":3}}),
        );
        let (shared, dir) = make_shared(&[
            ("a", chat.url.clone(), WireApi::Chat),
            ("b", native.url.clone(), WireApi::Responses),
        ]);
        let payload = json!({"model":"group/g","input":"hi","tools":[{"type":"web_search"}]});
        let response = route(
            request_ctx(
                &HeaderMap::new(),
                Endpoint::Responses,
                "group/g".into(),
                false,
            ),
            &shared,
            &payload,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(chat.hits.load(Ordering::SeqCst), 0);
        assert_eq!(native.hits.load(Ordering::SeqCst), 1);
        let sent = native.requests.lock().unwrap()[0].clone();
        assert_eq!(sent["tools"], payload["tools"]);
        assert_eq!(sent["input"], payload["input"]);
        let decision = &shared.router.recent(1)[0];
        assert_eq!(decision.attempts[0].outcome, "skipped");
        assert_eq!(decision.chosen.as_deref(), Some("b/m"));
        let trace: Vec<_> = decision
            .trace
            .iter()
            .map(|item| (item.member.as_str(), item.verdict, item.reasons.clone()))
            .collect();
        assert_eq!(
            trace,
            [
                (
                    "a/m",
                    "skipped",
                    vec!["strategy_first", "protocol_unsupported"]
                ),
                ("b/m", "chosen", vec!["fallback", "answered"]),
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
    });
}

fn sse_packets(
    chunks: Vec<(Duration, Vec<u8>)>,
    finish_transport: bool,
) -> Vec<(Duration, Vec<u8>)> {
    let mut packets = vec![(Duration::ZERO, b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec())];
    for (delay, bytes) in chunks {
        let mut packet = format!("{:x}\r\n", bytes.len()).into_bytes();
        packet.extend(bytes);
        packet.extend(b"\r\n");
        packets.push((delay, packet));
    }
    if finish_transport {
        packets.push((Duration::ZERO, b"0\r\n\r\n".to_vec()));
    }
    packets
}
async fn stream_case(
    endpoint: Endpoint,
    packets: Vec<(Duration, Vec<u8>)>,
) -> (String, LedgerRecord) {
    let upstream = Upstream::raw(packets);
    let (shared, dir) = make_shared(&[("a", upstream.url.clone(), WireApi::Chat)]);
    let payload = if endpoint == Endpoint::Responses {
        json!({"input":"hi"})
    } else {
        json!({"messages":[{"role":"user","content":"hi"}]})
    };
    let response = route(
        request_ctx(&HeaderMap::new(), endpoint, "a/m".into(), true),
        &shared,
        &payload,
    )
    .await;
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let record = shared.ledger.recent(1).unwrap().remove(0);
    std::fs::remove_dir_all(dir).unwrap();
    (String::from_utf8_lossy(&bytes).into_owned(), record)
}

#[test]
fn real_http_headers_whole_body_and_response_bytes_are_bounded() {
    run(async {
        let stalled_headers = Upstream::raw(vec![(
            UPSTREAM_HEADERS_TIMEOUT + Duration::from_millis(100),
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec(),
        )]);
        let stalled_body = Upstream::raw(vec![
            (
                Duration::ZERO,
                b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n".to_vec(),
            ),
            (
                WHOLE_RESPONSE_TIMEOUT + Duration::from_millis(100),
                b"a".to_vec(),
            ),
        ]);
        let oversize = Upstream::raw(vec![(
            Duration::ZERO,
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            )
            .into_bytes(),
        )]);
        for (fixture, expected) in [
            (&stalled_headers, "响应头"),
            (&stalled_body, "总时限"),
            (&oversize, "字节限制"),
        ] {
            let (shared, dir) = make_shared(&[("a", fixture.url.clone(), WireApi::Chat)]);
            let response = route(
                request_ctx(&HeaderMap::new(), Endpoint::Chat, "a/m".into(), false),
                &shared,
                &json!({"messages":[{"role":"user","content":"hi"}]}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
            let record = shared.ledger.recent(1).unwrap().remove(0);
            assert!(!record.ok);
            assert!(record.error.unwrap().contains(expected));
            std::fs::remove_dir_all(dir).unwrap();
        }
        // No Content-Length: enforce the same byte limit incrementally.
        let chunked = Upstream::raw(sse_packets(vec![(Duration::ZERO, vec![b'a'; 17])], true));
        let response = reqwest::get(&chunked.url).await.unwrap();
        assert!(read_upstream_body(response, 16, Instant::now())
            .await
            .unwrap_err()
            .contains("字节限制"));
    });
}

#[test]
fn real_http_streams_use_idle_deadlines_keep_partial_usage_and_bound_accumulation() {
    run(async {
        let usage =
            b"data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\n".to_vec();
        for endpoint in [Endpoint::Chat, Endpoint::Responses] {
            let mut chunks = vec![(Duration::ZERO, usage.clone())];
            // Gaps stay well under the idle deadline, yet together outlast it.
            for _ in 0..8 {
                chunks.push((
                    Duration::from_millis(150),
                    b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n"
                        .to_vec(),
                ));
            }
            chunks.push((Duration::ZERO, b"data: [DONE]\n\n".to_vec()));
            let (text, record) = stream_case(endpoint, sse_packets(chunks, true)).await;
            assert!(record.ok, "{:?}", record.error);
            assert_eq!(
                record.input,
                10,
                "endpoint={} error={:?} text={}",
                endpoint.as_str(),
                record.error,
                text
            );
            assert!(text.contains("think"));
            // The usage-only event is not output; the first reasoning delta is.
            let first = record.first_token_ms.expect("first token time");
            assert!(first >= 100 && first <= record.latency_ms, "{first}");
            let (text, record) = stream_case(
                endpoint,
                sse_packets(
                    vec![
                        (Duration::ZERO, usage.clone()),
                        (
                            STREAM_IDLE_TIMEOUT + Duration::from_millis(500),
                            b": heartbeat\n\n".to_vec(),
                        ),
                    ],
                    true,
                ),
            )
            .await;
            assert!(!record.ok);
            assert_eq!(
                record.input,
                10,
                "endpoint={} error={:?} text={}",
                endpoint.as_str(),
                record.error,
                text
            );
            assert!(record.error.unwrap().contains("没有数据"));
            assert!(text.contains("error"));
            let (_, record) = stream_case(
                endpoint,
                sse_packets(vec![(Duration::ZERO, usage.clone())], true),
            )
            .await;
            assert!(!record.ok);
            assert_eq!(
                record.input,
                10,
                "endpoint={} error={:?} text={}",
                endpoint.as_str(),
                record.error,
                text
            );
            assert!(record.error.unwrap().contains("结束事件"));
            let (_, record) = stream_case(
                endpoint,
                sse_packets(
                    vec![(
                        Duration::ZERO,
                        vec![b'a'; super::super::ledger::MAX_SSE_LINE_BYTES + 1],
                    )],
                    true,
                ),
            )
            .await;
            assert!(!record.ok);
            assert!(
                record.error.as_ref().unwrap().contains("单行"),
                "endpoint={} error={:?}",
                endpoint.as_str(),
                record.error
            );
        }
        let event_line = [vec![b':'; 600_000], b"\n".to_vec()].concat();
        let (_, record) = stream_case(
            Endpoint::Chat,
            sse_packets(
                (0..4)
                    .map(|_| (Duration::ZERO, event_line.clone()))
                    .collect(),
                true,
            ),
        )
        .await;
        assert!(!record.ok);
        assert!(record.error.unwrap().contains("单事件"));
        let event = format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{"content":"a".repeat(100_000)}}]})
        )
        .into_bytes();
        let (_, record) = stream_case(
            Endpoint::Responses,
            sse_packets(
                (0..90).map(|_| (Duration::ZERO, event.clone())).collect(),
                true,
            ),
        )
        .await;
        assert!(!record.ok);
        assert!(record.error.unwrap().contains("累计输入"));
        let (sender, _receiver) = mpsc::channel(1);
        let mut emitted = MAX_STREAM_BYTES;
        assert!(send_events(&sender, vec!["x".into()], &mut emitted)
            .await
            .unwrap_err()
            .contains("总响应"));
        let mut emitted = 0;
        assert!(send_events(
            &sender,
            vec!["x".repeat(MAX_CONVERTED_EVENT_BYTES + 1)],
            &mut emitted
        )
        .await
        .unwrap_err()
        .contains("事件"));
        // Cancellation is observed while waiting for upstream bytes, without
        // waiting for the idle deadline.
        let waiting = Upstream::raw(sse_packets(
            vec![(
                STREAM_IDLE_TIMEOUT + Duration::from_millis(500),
                b": wait\n\n".to_vec(),
            )],
            true,
        ));
        let response = reqwest::get(&waiting.url).await.unwrap();
        let mut stream = response.bytes_stream();
        let (sender, receiver) = mpsc::channel(1);
        drop(receiver);
        let start = Instant::now();
        assert!(next_chunk(&mut stream, &sender)
            .await
            .unwrap_err()
            .contains("提前断开"));
        assert!(start.elapsed() < STREAM_IDLE_TIMEOUT);
        let (sender, _receiver) = mpsc::channel(1);
        sender.send(Bytes::from_static(b"full")).await.unwrap();
        assert!(send_chunk(&sender, Bytes::from_static(b"blocked"))
            .await
            .unwrap_err()
            .contains("未读取"));
    });
}

static HTTP_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[test]
fn real_http_ingress_timeout_and_admission_are_bounded() {
    run(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let upstream = Upstream::new(200, json!({"choices":[{"message":{"content":"ok"}}]}));
        let (shared, dir) = make_shared(&[("a", upstream.url.clone(), WireApi::Chat)]);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(serve(
            listener,
            shared.clone(),
            Arc::from("fixture-token"),
            Arc::new(AtomicBool::new(true)),
        ));
        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        client.write_all(format!("POST /v1/chat/completions HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer fixture-token\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{{").as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("408"));
        assert_eq!(upstream.hits.load(Ordering::SeqCst), 0);
        let mut oversized = tokio::net::TcpStream::connect(addr).await.unwrap();
        oversized.write_all(format!("POST /v1/chat/completions HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer fixture-token\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",MAX_REQUEST_BYTES+1).as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), oversized.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("413"));
        let permits: Vec<_> = (0..MAX_ACTIVE_REQUESTS)
            .map(|_| REQUEST_SLOTS.try_acquire().unwrap())
            .collect();
        let response = reqwest::get(format!("http://{addr}/health")).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        drop(permits);
        let mut held = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            held.push(tokio::net::TcpStream::connect(addr).await.unwrap());
            tokio::task::yield_now().await;
        }
        // Extra sockets are closed immediately instead of accumulating tasks.
        let mut excess = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut byte = [0u8; 1];
        let result = tokio::time::timeout(Duration::from_secs(1), excess.read(&mut byte))
            .await
            .unwrap();
        assert!(matches!(result, Ok(0) | Err(_)));
        drop(held);
        task.abort();
        std::fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn real_http_gemini_clients_cannot_inherit_each_others_models() {
    run(async {
        let a = Upstream::new(
            200,
            json!({"choices":[{"message":{"content":"A"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}),
        );
        let b = Upstream::new(
            200,
            json!({"choices":[{"message":{"content":"B"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}),
        );
        let (shared, dir) = make_shared(&[
            ("a", a.url.clone(), WireApi::Chat),
            ("b", b.url.clone(), WireApi::Chat),
        ]);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(serve(
            listener,
            shared.clone(),
            Arc::from("fixture-token"),
            Arc::new(AtomicBool::new(true)),
        ));
        let client = reqwest::Client::new();
        let models: Value = client
            .get(format!("http://{addr}/v1beta/models"))
            .header("x-goog-api-key", "fixture-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(models["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["name"] == "models/a/m"));
        assert!(models["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["name"] == "models/b/m"));
        let body = json!({"contents":[{"role":"user","parts":[{"text":"hi"}]}]});
        for (model, session, expected) in [
            ("a%2Fm", Some("A"), 200),
            ("gemini-helper", Some("A"), 400),
            ("b%2Fm", Some("B"), 200),
            ("gemini-helper", Some("A"), 400),
            ("gemini-helper", None, 400),
            ("a/m", Some("A"), 200),
        ] {
            let mut request = client
                .post(format!(
                    "http://{addr}/v1beta/models/{model}:generateContent"
                ))
                .header("x-goog-api-key", "fixture-token")
                .json(&body);
            if let Some(session) = session {
                request = request.header("x-session-id", session);
            }
            let response = request.send().await.unwrap();
            assert_eq!(response.status().as_u16(), expected);
            let value: Value = response.json().await.unwrap();
            if expected == 200 {
                assert_eq!(
                    value["candidates"][0]["content"]["parts"][0]["text"],
                    if model.starts_with('a') { "A" } else { "B" }
                );
            }
        }
        assert_eq!(a.hits.load(Ordering::SeqCst), 2);
        assert_eq!(b.hits.load(Ordering::SeqCst), 1);
        assert_eq!(a.requests.lock().unwrap()[0]["model"], "m");
        assert_eq!(b.requests.lock().unwrap()[0]["model"], "m");
        task.abort();
        std::fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn real_http_supported_content_survives_and_bad_structure_never_reaches_native() {
    run(async {
        let chat = Upstream::new(
            200,
            json!({"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}),
        );
        let native = Upstream::new(200, json!({"content":[]}));
        let (shared, dir) = make_shared(&[
            ("a", chat.url.clone(), WireApi::Chat),
            ("b", native.url.clone(), WireApi::Anthropic),
        ]);
        for (endpoint, payload) in [
            (
                Endpoint::Responses,
                json!({"input":[{"role":"user","content":[{"type":"input_text","text":"look"},{"type":"input_image","image_url":"data:image/png;base64,AA"}]}],"tools":[{"type":"function","name":"f","parameters":{"type":"object"},"strict":true}]}),
            ),
            (
                Endpoint::Messages,
                json!({"messages":[{"role":"user","content":[{"type":"text","text":"look"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA"}}]}],"tools":[{"name":"f","input_schema":{"type":"object"}}]}),
            ),
        ] {
            let response = route(
                request_ctx(&HeaderMap::new(), endpoint, "a/m".into(), false),
                &shared,
                &payload,
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let sent = chat.requests.lock().unwrap().last().unwrap().clone();
            assert_eq!(sent["messages"][0]["content"][0]["text"], "look");
            assert_eq!(
                sent["messages"][0]["content"][1]["image_url"]["url"],
                "data:image/png;base64,AA"
            );
            assert_eq!(sent["tools"][0]["function"]["name"], "f");
            if endpoint == Endpoint::Responses {
                assert_eq!(sent["tools"][0]["function"]["strict"], true);
            }
        }
        for payload in [
            json!({"messages":[{"role":"user","content":[{"type":"image","source":{}}]}]}),
            json!({"messages":[],"tools":[null]}),
            json!({"messages":[],"stream":"yes"}),
        ] {
            let response = route(
                request_ctx(&HeaderMap::new(), Endpoint::Messages, "b/m".into(), false),
                &shared,
                &payload,
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        assert_eq!(native.hits.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn real_http_nested_semantics_are_rejected_before_outbound_connection() {
    run(async {
        let chat = Upstream::new(200, json!({"choices":[{"message":{"content":"unused"}}]}));
        let (shared, dir) = make_shared(&[("a", chat.url.clone(), WireApi::Chat)]);
        let responses = json!({"input":[{"role":"user","content":[{"type":"input_text","text":"hi"},{"type":"input_image","image_url":"https://example.com/a.png"}]}],"tools":[{"type":"function","name":"f","parameters":{"type":"object"}}],"tool_choice":{"type":"function","name":"f"}});
        let messages = json!({"messages":[{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image","source":{"type":"url","url":"https://example.com/a.png"}}]}],"tools":[{"name":"f","input_schema":{"type":"object"}}],"tool_choice":{"type":"tool","name":"f"}});
        for (endpoint, base, paths) in [
            (
                Endpoint::Responses,
                responses,
                &[
                    "/input/0",
                    "/input/0/content/0",
                    "/input/0/content/1",
                    "/tools/0",
                    "/tool_choice",
                ][..],
            ),
            (
                Endpoint::Messages,
                messages,
                &[
                    "/messages/0",
                    "/messages/0/content/0",
                    "/messages/0/content/1/source",
                    "/tools/0",
                    "/tool_choice",
                ][..],
            ),
        ] {
            for path in paths {
                let mut payload = base.clone();
                payload
                    .pointer_mut(path)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .insert("future_semantic_requirement".into(), json!("must-preserve"));
                let response = route(
                    request_ctx(&HeaderMap::new(), endpoint, "a/m".into(), false),
                    &shared,
                    &payload,
                )
                .await;
                assert_eq!(
                    response.status(),
                    StatusCode::BAD_REQUEST,
                    "{} {path}",
                    endpoint.as_str()
                );
            }
        }
        let annotated = json!({"input":[{"role":"assistant","content":[{"type":"output_text","text":"cited","annotations":[{"type":"url_citation","start_index":0,"end_index":5,"url":"https://example.com/evidence","title":"source"}]}]}]});
        assert_eq!(
            route(
                request_ctx(&HeaderMap::new(), Endpoint::Responses, "a/m".into(), false),
                &shared,
                &annotated
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(chat.hits.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn real_http_null_error_lifecycle_events_complete_and_nonnull_errors_fail() {
    run(async {
        let event = |value: &Value| format!("data: {value}\n\n").into_bytes();
        for failure in [false, true] {
            let created =
                json!({"type":"response.created","response":{"status":"in_progress","error":null}});
            let completed = json!({"type":if failure {"response.failed"} else {"response.completed"},"error":null,"response":{"status":if failure {"failed"} else {"completed"},"error":if failure {json!({"message":"fixture failure"})} else {Value::Null},"usage":{"input_tokens":10,"output_tokens":2}}});
            let upstream = Upstream::raw(sse_packets(
                vec![
                    (Duration::ZERO, event(&created)),
                    (Duration::from_millis(20), event(&completed)),
                ],
                true,
            ));
            let (shared, dir) = make_shared(&[("a", upstream.url.clone(), WireApi::Responses)]);
            let response = route(
                request_ctx(&HeaderMap::new(), Endpoint::Responses, "a/m".into(), true),
                &shared,
                &json!({"input":"hi"}),
            )
            .await;
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let text = String::from_utf8_lossy(&bytes);
            assert!(text.contains("response.created"));
            assert!(text.contains(if failure {
                "response.failed"
            } else {
                "response.completed"
            }));
            let record = shared.ledger.recent(1).unwrap().remove(0);
            assert_eq!(record.ok, !failure);
            assert_eq!((record.input, record.output), (10, 2));
            if failure {
                assert!(record.error.unwrap().contains("fixture failure"));
            } else {
                assert!(record.error.is_none());
            }
            std::fs::remove_dir_all(dir).unwrap();
        }
        // Chat→Responses conversion must also ignore its top-level error:null.
        for failure in [false, true] {
            let mut chunks = vec![(
                Duration::ZERO,
                event(
                    &json!({"error":null,"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}),
                ),
            )];
            chunks.push((Duration::from_millis(20),event(&json!({"error":if failure {json!({"message":"chat failure"})} else {Value::Null},"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}))));
            if !failure {
                chunks.push((Duration::ZERO, b"data: [DONE]\n\n".to_vec()));
            }
            let (text, record) = stream_case(Endpoint::Responses, sse_packets(chunks, true)).await;
            assert!(text.contains(if failure {
                "response.failed"
            } else {
                "response.completed"
            }));
            assert_eq!(record.ok, !failure);
            assert_eq!((record.input, record.output), (10, 2));
            if failure {
                assert!(record.error.unwrap().contains("chat failure"));
            }
        }
    });
}

#[test]
fn real_http_stopped_generation_rejects_keepalive_and_preflight() {
    run(async {
        let upstream = Upstream::new(200, json!({"choices":[{"message":{"content":"ok"}}]}));
        let (shared, dir) = make_shared(&[("a", upstream.url.clone(), WireApi::Chat)]);
        let gateway = super::super::Gateway::new(&dir, shared.secrets.clone(), 0);
        gateway
            .upsert_provider(shared.providers.read().unwrap()[0].clone())
            .unwrap();
        let addr: std::net::SocketAddr = format!("127.0.0.1:{}", gateway.status().port)
            .parse()
            .unwrap();
        let gate = gateway
            .listener
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .gate
            .clone();
        let local_token = gateway.local_token().unwrap();
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .unwrap();
        let connection_task = tokio::spawn(connection);
        let request = || {
            Request::builder()
                .method(Method::POST)
                .uri("/v1/chat/completions")
                .header(HOST, addr.to_string())
                .header(AUTHORIZATION, format!("Bearer {local_token}"))
                .body(Full::new(Bytes::from_static(
                    br#"{"model":"a/m","messages":[{"role":"user","content":"hi"}]}"#,
                )))
                .unwrap()
        };
        let response = sender.send_request(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response.into_body().collect().await.unwrap();
        assert_eq!(upstream.hits.load(Ordering::SeqCst), 1);
        gateway.set_enabled(false);
        assert!(!gate.load(Ordering::SeqCst));
        match sender.send_request(request()).await {
            Ok(response) => assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE),
            Err(_) => (), // stop also closes every owned connection.
        }
        assert_eq!(upstream.hits.load(Ordering::SeqCst), 1);
        let mut ctx = request_ctx(&HeaderMap::new(), Endpoint::Chat, "a/m".into(), false);
        ctx.gate = Some(gate.clone());
        let response = route(
            ctx,
            &shared,
            &json!({"messages":[{"role":"user","content":"hi"}]}),
        )
        .await;
        assert!(!response.status().is_success());
        assert_eq!(upstream.hits.load(Ordering::SeqCst), 1);
        gateway.set_enabled(true);
        assert!(!gate.load(Ordering::SeqCst));
        assert!(!Arc::ptr_eq(
            &gate,
            &gateway.listener.lock().unwrap().as_ref().unwrap().gate
        ));
        assert!(sender.send_request(request()).await.is_err());
        gateway.set_enabled(false);
        connection_task.abort();
        std::fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn real_http_explicit_keyless_loopback_and_redirects_are_safe() {
    run(async {
        let remote = Upstream::new(200, json!({"choices":[]}));
        let redirect = Upstream::raw(vec![(Duration::ZERO, format!("HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", remote.url).into_bytes())]);
        let local = Upstream::new(200, json!({"choices":[{"message":{"content":"ok"}}]}));
        let (shared, dir) = make_shared(&[("a", local.url.clone(), WireApi::Chat)]);
        shared.secrets.delete(&provider_account("a")).unwrap();
        let ask = json!({"messages":[{"role":"user","content":"hi"}]});
        let call = || request_ctx(&HeaderMap::new(), Endpoint::Chat, "a/m".into(), false);
        assert_eq!(
            route(call(), &shared, &ask).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(local.hits.load(Ordering::SeqCst), 0);
        shared.providers.write().unwrap()[0].auth_mode = AuthMode::None;
        assert_eq!(route(call(), &shared, &ask).await.status(), StatusCode::OK);
        assert_eq!(local.hits.load(Ordering::SeqCst), 1);
        assert_eq!(*local.auth_headers.lock().unwrap(), vec![None]);
        shared.providers.write().unwrap()[0].base_url = redirect.url.clone();
        assert_eq!(
            route(call(), &shared, &ask).await.status(),
            StatusCode::FOUND
        );
        assert_eq!(redirect.hits.load(Ordering::SeqCst), 1);
        assert_eq!(remote.hits.load(Ordering::SeqCst), 0);
        shared.providers.write().unwrap()[0].base_url = "https://remote.example/v1".into();
        assert_eq!(
            route(call(), &shared, &ask).await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(remote.hits.load(Ordering::SeqCst), 0);
        // The upstream exemption does not bypass gateway ingress authentication.
        let gateway = super::super::Gateway::new(&dir, shared.secrets.clone(), 0);
        let mut record = shared.providers.read().unwrap()[0].clone();
        record.base_url = local.url.clone();
        gateway.upsert_provider(record).unwrap();
        let response = reqwest::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/v1/chat/completions",
                gateway.status().port
            ))
            .json(&json!({"model":"a/m","messages":[{"role":"user","content":"hi"}]}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(local.hits.load(Ordering::SeqCst), 1);
        gateway.set_enabled(false);
        std::fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn real_http_gemini_rejects_raw_semantic_loss_before_any_upstream() {
    run(async {
        let upstream = Upstream::new(200, json!({"choices":[{"message":{"content":"ok"}}]}));
        let (shared, dir) = make_shared(&[("a", upstream.url.clone(), WireApi::Chat)]);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(serve(
            listener,
            shared,
            Arc::from("fixture-token"),
            Arc::new(AtomicBool::new(true)),
        ));
        let client = reqwest::Client::new();
        let endpoint = format!("http://{addr}/v1beta/models/a/m:generateContent");
        let ask = json!({"contents":[{"role":"user","parts":[{"text":"hi"}]}]});
        let mut rejected = Vec::new();
        for field in ["googleSearch", "codeExecution", "urlContext", "retrieval"] {
            let mut body = ask.clone();
            body["tools"] = json!([{field:{}}]);
            rejected.push(body);
        }
        for mime in ["application/pdf", "audio/wav", "video/mp4"] {
            let mut body = ask.clone();
            body["contents"][0]["parts"] = json!([{"inlineData":{"mimeType":mime,"data":"AA"}}]);
            rejected.push(body);
        }
        for config in [
            json!({"thinkingConfig":{"thinkingBudget":1024}}),
            json!({"responseJsonSchema":{"type":"object"}}),
            json!({"candidateCount":2}),
        ] {
            let mut body = ask.clone();
            body["generationConfig"] = config;
            rejected.push(body);
        }
        for parts in [
            json!([{"text":"thought","thought":true}]),
            json!([{"text":"thought","thoughtSignature":"signed"}]),
            json!([{"unknown":{}}]),
            json!([{"fileData":{"mimeType":"image/png","fileUri":"gs://bucket/image"}}]),
        ] {
            let mut body = ask.clone();
            body["contents"][0]["parts"] = parts;
            rejected.push(body);
        }
        let tools = json!([{"functionDeclarations":[{"name":"a"},{"name":"b"}]}]);
        let mut body = ask.clone();
        body["tools"] = tools.clone();
        body["toolConfig"] =
            json!({"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["a","b"]}});
        rejected.push(body);
        let mut body = ask.clone();
        body["tools"] = tools.clone();
        body["toolConfig"] =
            json!({"functionCallingConfig":{"mode":"AUTO","allowedFunctionNames":["a"]}});
        rejected.push(body);
        let mut body = ask.clone();
        body["safetySettings"] = json!([]);
        rejected.push(body);
        let mut body = ask.clone();
        body["cachedContent"] = json!("cached-1");
        rejected.push(body);
        for body in rejected {
            let response = client
                .post(&endpoint)
                .bearer_auth("fixture-token")
                .json(&body)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{body}");
            let error: Value = response.json().await.unwrap();
            assert_eq!(error["error"]["status"], "INVALID_ARGUMENT");
            assert_eq!(upstream.hits.load(Ordering::SeqCst), 0);
        }
        let positive = json!({"contents":[{"role":"user","parts":[{"text":"look"},{"inlineData":{"mimeType":"image/png","data":"AA"}},{"fileData":{"mimeType":"image/png","fileUri":"HTTPS://example.com/one.png"}},{"fileData":{"mimeType":"image/jpeg","fileUri":"HtTp://example.com/two.jpg"}}]}],"tools":tools,"toolConfig":{"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":["a"]}},"generationConfig":{"temperature":0.2,"maxOutputTokens":64}});
        let response = client
            .post(&endpoint)
            .bearer_auth("fixture-token")
            .json(&positive)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(upstream.hits.load(Ordering::SeqCst), 1);
        let payload = upstream.requests.lock().unwrap()[0].clone();
        assert_eq!(payload["messages"][0]["content"][1]["type"], "image_url");
        assert_eq!(
            payload["messages"][0]["content"][2]["image_url"]["url"],
            "https://example.com/one.png"
        );
        assert_eq!(
            payload["messages"][0]["content"][3]["image_url"]["url"],
            "http://example.com/two.jpg"
        );
        assert_eq!(payload["tools"].as_array().unwrap().len(), 2);
        assert_eq!(payload["tool_choice"]["function"]["name"], "a");
        task.abort();
        std::fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn real_http_fixed_port_restarts_without_waiting_for_abort() {
    run(async {
        let upstream = Upstream::new(200, json!({"choices":[]}));
        let (shared, dir) = make_shared(&[("a", upstream.url.clone(), WireApi::Chat)]);
        let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let gateway = super::super::Gateway::new(&dir, shared.secrets.clone(), port);
        gateway
            .upsert_provider(shared.providers.read().unwrap()[0].clone())
            .unwrap();
        // Rapid stop/start also covers a task that has not polled accept yet.
        for _ in 0..20 {
            gateway.set_enabled(false);
            drop(std::net::TcpListener::bind(("127.0.0.1", port)).unwrap());
            gateway.set_enabled(true);
            assert!(gateway.status().running);
        }
        // Old pooled sockets intentionally belong to the stopped generation;
        // use a fresh TCP connection to verify the new listener here.
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .build()
            .unwrap();
        for _ in 0..20 {
            let status = gateway.status();
            assert!(status.running, "{status:?}");
            assert_eq!(status.port, port);
            let response = client
                .get(format!("http://127.0.0.1:{port}/health"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            response.bytes().await.unwrap();
            let gate = gateway
                .listener
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .gate
                .clone();
            gateway.set_enabled(false);
            assert!(!gate.load(Ordering::SeqCst));
            // Synchronous ownership releases the listener before stop returns.
            drop(std::net::TcpListener::bind(("127.0.0.1", port)).unwrap());
            gateway.set_enabled(true);
            assert!(
                gateway.status().running,
                "immediate restart must bind the fixed port"
            );
            assert!(!Arc::ptr_eq(
                &gate,
                &gateway.listener.lock().unwrap().as_ref().unwrap().gate
            ));
        }
        gateway.set_enabled(false);
        assert_eq!(upstream.hits.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(dir).unwrap();
    });
}

struct WaitingSecrets {
    inner: MemorySecrets,
    armed: AtomicBool,
    entered: AtomicBool,
    finished: AtomicBool,
    released: std::sync::Mutex<bool>,
    wake: std::sync::Condvar,
}
impl SecretStore for WaitingSecrets {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        if account == provider_account("a") && self.armed.swap(false, Ordering::SeqCst) {
            self.entered.store(true, Ordering::SeqCst);
            let (released, timeout) = self
                .wake
                .wait_timeout_while(
                    self.released.lock().unwrap(),
                    Duration::from_secs(3),
                    |released| !*released,
                )
                .unwrap();
            if timeout.timed_out() && !*released {
                return Err("fixture credential wait timed out".into());
            }
            self.finished.store(true, Ordering::SeqCst);
        }
        self.inner.get(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.inner.set(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.inner.delete(account)
    }
}

#[test]
fn real_http_stop_during_credential_wait_never_connects_upstream() {
    run(async {
        let upstream = Upstream::new(200, json!({"choices":[]}));
        let (shared, dir) = make_shared(&[("a", upstream.url.clone(), WireApi::Chat)]);
        let secrets = Arc::new(WaitingSecrets {
            inner: MemorySecrets::default(),
            armed: AtomicBool::new(false),
            entered: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            released: std::sync::Mutex::new(false),
            wake: std::sync::Condvar::new(),
        });
        secrets.set(&provider_account("a"), "fixture-key").unwrap();
        let gateway = super::super::Gateway::new(&dir, secrets.clone(), 0);
        gateway
            .upsert_provider(shared.providers.read().unwrap()[0].clone())
            .unwrap();
        let port = gateway.status().port;
        let token = gateway.local_token().unwrap();
        secrets.armed.store(true, Ordering::SeqCst);
        let request = tokio::spawn(async move {
            reqwest::Client::new()
                .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
                .bearer_auth(token)
                .json(&json!({"model":"a/m","messages":[{"role":"user","content":"hi"}]}))
                .send()
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !secrets.entered.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        gateway.set_enabled(false);
        *secrets.released.lock().unwrap() = true;
        secrets.wake.notify_all();
        if let Ok(response) = tokio::time::timeout(Duration::from_secs(2), request)
            .await
            .unwrap()
            .unwrap()
        {
            assert!(!response.status().is_success());
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            while !secrets.finished.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(upstream.hits.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(dir).unwrap();
    });
}

#[test]
fn upstream_error_text_never_carries_the_presented_key() {
    let key = "sk-test-0123456789abcdef";
    let echoed = format!("{{\"error\":\"Incorrect API key provided: {key}\"}}");
    let redacted = redact_key(&echoed, &format!(" {key} "));
    assert!(!redacted.contains(key));
    assert!(redacted.contains("[已隐去 API key]"));
    // Too short to be a key: left alone so ordinary words are not mangled.
    assert_eq!(redact_key("error abc", "abc"), "error abc");
    assert_eq!(redact_key("plain", ""), "plain");
}

#[test]
fn first_output_ignores_lifecycle_events() {
    let cases = [
        (
            WireApi::Chat,
            json!({"choices":[{"delta":{"role":"assistant","content":""}}]}),
            false,
        ),
        (
            WireApi::Chat,
            json!({"choices":[{"delta":{"content":"Hi"}}]}),
            true,
        ),
        (
            WireApi::Chat,
            json!({"choices":[{"delta":{"reasoning_content":"…"}}]}),
            true,
        ),
        (
            WireApi::Chat,
            json!({"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}),
            true,
        ),
        (
            WireApi::Responses,
            json!({"type":"response.created"}),
            false,
        ),
        (
            WireApi::Responses,
            json!({"type":"response.output_text.delta","delta":"a"}),
            true,
        ),
        (WireApi::Anthropic, json!({"type":"message_start"}), false),
        (
            WireApi::Anthropic,
            json!({"type":"content_block_delta"}),
            true,
        ),
    ];
    for (wire, event, expected) in cases {
        assert_eq!(carries_output(wire, &event), expected, "{event}");
    }
}

#[test]
fn upstream_error_text_masks_anything_shaped_like_a_credential() {
    let cases = [
        "Incorrect API key provided: sk-proj-AbCdEf0123456789xyz.",
        "invalid x-api-key sk-ant-api03-AbCdEf0123456789_xyz",
        "Authorization: Bearer abcdefABCDEF0123456789",
        "key AIzaSyA0123456789abcdefghijklmnop is invalid",
        "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl expired",
        "gsk_0123456789abcdefABCDEF rejected",
    ];
    for text in cases {
        let redacted = redact_key(text, "another-key-entirely");
        assert!(
            redacted.contains("[已隐去 API key]"),
            "{text} -> {redacted}"
        );
        for secret in ["0123456789", "AbCdEf0123", "abcdefABCDEF"] {
            assert!(!redacted.contains(secret), "{text} -> {redacted}");
        }
    }
    // Ordinary error text is left alone.
    for text in [
        "model not found: gpt-4o-mini",
        "rate limit exceeded, retry after 20s",
        "task-scheduler busy",
        "error code key_not_found_in_request",
        "sk-short",
    ] {
        assert_eq!(redact_key(text, ""), text);
    }
}
