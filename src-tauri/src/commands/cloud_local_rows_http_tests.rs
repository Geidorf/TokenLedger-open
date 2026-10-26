use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration as StdDuration, Instant};

struct LedgerFixture {
    app: AppContext,
    path: PathBuf,
}

impl LedgerFixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "tokenledger-local-rows-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let app = AppContext::for_test(root);
        let path = db::get_db_path(&app);
        db::init_test_db(&path).unwrap();
        Self { app, path }
    }
}

impl Drop for LedgerFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.path.parent().unwrap());
    }
}

#[test]
fn pending_upload_count_excludes_restored_peer_rows() {
    let ledger = LedgerFixture::new();
    let local = fallback_machine_id(&ledger.path);
    let conn = db::get_connection(&ledger.path).unwrap();
    for (key, machine) in [
        ("current", local.as_str()),
        ("legacy-empty", ""),
        ("peer", "peer-device"),
    ] {
        conn.execute(
            "INSERT INTO token_logs
             (tool,model,timestamp,session_id,unique_key,machine_id,input_tokens,output_tokens,sync_status)
             VALUES ('fixture-tool','fixture-model','2026-10-01 10:00:00',?1,?1,?2,1,1,0)",
            params![key, machine],
        )
        .unwrap();
    }
    let info = get_db_info_impl(&ledger.app).unwrap();
    assert_eq!(info["totalRecords"], 3);
    assert_eq!(info["unsyncedRecords"], 2);
}

#[test]
fn ready_purges_and_pending_work_ignore_peer_devices() {
    let ledger = LedgerFixture::new();
    let local = fallback_machine_id(&ledger.path);
    let conn = db::get_connection(&ledger.path).unwrap();
    conn.execute_batch(
        "DELETE FROM pending_cloud_purges;
         INSERT INTO pending_cloud_purges (tool,machine_id,ready)
             VALUES ('fixture-tool','peer-device',1)",
    )
    .unwrap();
    assert!(!conn
        .query_row(
            PENDING_SYNC_WORK_SQL,
            params!["fixture-user", local],
            |row| row.get::<_, bool>(0),
        )
        .unwrap());
    assert!(load_ready_cloud_purges(&ledger.path, &local)
        .unwrap()
        .is_empty());
    for (tool, machine) in [("current-tool", local.as_str()), ("legacy-tool", "")] {
        conn.execute(
            "INSERT INTO pending_cloud_purges (tool,machine_id,ready) VALUES (?1,?2,1)",
            params![tool, machine],
        )
        .unwrap();
    }
    let purges = load_ready_cloud_purges(&ledger.path, &local).unwrap();
    assert_eq!(purges.len(), 2);
    assert!(purges.iter().all(|(_, _, machine)| machine == &local));
}

#[test]
fn aggregate_deletion_keeps_the_current_device_filter_on_the_wire() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback fixture");
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + StdDuration::from_secs(5);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "no deletion request received");
                    std::thread::sleep(StdDuration::from_millis(2));
                }
                Err(error) => panic!("accept fixture request: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(StdDuration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(StdDuration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let size = stream.read(&mut buffer).expect("read fixture request");
            assert!(size > 0, "request ended before its headers");
            request.extend_from_slice(&buffer[..size]);
            assert!(request.len() < 16_384, "fixture request is too large");
        }
        stream
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .unwrap();
        String::from_utf8(request)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .to_string()
    });

    let config = CloudConfig {
        supabase_url: endpoint,
        supabase_key: "fixture-public-key".into(),
        ..CloudConfig::default()
    };
    let session = CloudSession {
        user_id: "fixture-user".into(),
        access_token: "fixture-session".into(),
        ..CloudSession::default()
    };
    // 旧状态可以混有外机键；服务端设备条件必须独立限制删除范围。
    let keys = vec![
        "agg_current-device_tool_model_2026-10-01 10:00:00".into(),
        "agg_peer-device_tool_model,quoted_2026-10-01 10:00:00".into(),
    ];
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = runtime.block_on(async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(StdDuration::from_secs(3))
            .build()
            .unwrap();
        cloud_aggregate_delete_request(&client, &config, &session, "current-device", &keys)
            .send()
            .await
    });
    let request_line = server.join().expect("join fixture server");
    assert_eq!(result.unwrap().status(), reqwest::StatusCode::NO_CONTENT);
    let parts: Vec<_> = request_line.split_whitespace().collect();
    assert_eq!(parts[0], "DELETE");
    let url = Url::parse(&format!("http://fixture.invalid{}", parts[1])).unwrap();
    assert_eq!(url.path(), "/rest/v1/token_logs");
    let filters: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(
        filters.get("user_id").map(String::as_str),
        Some("eq.fixture-user")
    );
    assert_eq!(
        filters.get("machine_id").map(String::as_str),
        Some("eq.current-device")
    );
    assert_eq!(
        filters.get("unique_key"),
        Some(&gateway_cloud::postgrest_in_filter(&keys))
    );
}
