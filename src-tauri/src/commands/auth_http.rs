//! Authentication has its own budget: do not reuse retries for read-only cloud APIs.
use std::time::Duration;

use futures_util::future::{select, Either};
use reqwest::{redirect::Policy, Client, StatusCode};
use serde_json::Value;

#[derive(Clone, Copy)]
pub(super) enum AuthOperation {
    SignIn,
    SignUp,
}

#[derive(Clone, Copy)]
struct AuthLimits {
    connect: Duration,
    attempt: Duration,
    total: Duration,
    poll: Duration,
    backoff: Duration,
    success_bytes: usize,
    error_bytes: usize,
}

const AUTH_LIMITS: AuthLimits = AuthLimits {
    connect: Duration::from_secs(5),
    attempt: Duration::from_secs(12),
    total: Duration::from_secs(25),
    poll: Duration::from_millis(100),
    backoff: Duration::from_millis(300),
    success_bytes: 64 * 1024,
    error_bytes: 8 * 1024,
};

const TIMEOUT: &str = "Supabase authentication timed out. Please retry.";
const NETWORK: &str = "Supabase authentication network connection failed. Please retry.";
const INVALID_RESPONSE: &str = "Invalid Supabase authentication response.";
const TOO_LARGE: &str = "Supabase authentication response exceeded the size limit.";

pub(super) async fn request_auth<F>(
    url: &str,
    public_key: &str,
    credentials: &Value,
    operation: AuthOperation,
    ensure_current: F,
) -> Result<Value, String>
where
    F: Fn() -> Result<(), String>,
{
    request_auth_with_limits(
        url,
        public_key,
        credentials,
        operation,
        ensure_current,
        AUTH_LIMITS,
    )
    .await
}

async fn request_auth_with_limits<F>(
    url: &str,
    public_key: &str,
    credentials: &Value,
    operation: AuthOperation,
    ensure_current: F,
    limits: AuthLimits,
) -> Result<Value, String>
where
    F: Fn() -> Result<(), String>,
{
    ensure_current()?;
    let work = async {
        let client = Client::builder()
            .connect_timeout(limits.connect)
            .timeout(limits.attempt)
            // An auth POST contains credentials; no destination may redirect it.
            .redirect(Policy::none())
            .build()
            .map_err(|_| "Supabase authentication client unavailable.".to_string())?;
        let mut retried = false;
        let response = loop {
            ensure_current()?;
            match client
                .post(url)
                .header("apikey", public_key)
                .json(credentials)
                .send()
                .await
            {
                Ok(response) => break response,
                Err(error)
                    if matches!(operation, AuthOperation::SignIn)
                        && !retried
                        && error.is_connect()
                        && !error.is_timeout() =>
                {
                    // Never replay signup, a response, or an ambiguous post-send failure.
                    retried = true;
                    tokio::time::sleep(limits.backoff).await;
                }
                Err(error) => {
                    return Err(if error.is_timeout() { TIMEOUT } else { NETWORK }.to_string())
                }
            }
        };
        let status = response.status();
        let cap = if status.is_success() {
            limits.success_bytes
        } else {
            limits.error_bytes
        };
        let bytes = read_bounded(response, cap).await?;
        ensure_current()?;
        if !status.is_success() {
            // No raw body, URL, reqwest error, or credential is sent to UI/logs.
            return Err(safe_status_error(status));
        }
        serde_json::from_slice(&bytes).map_err(|_| INVALID_RESPONSE.to_string())
    };
    let cancellation = async {
        loop {
            ensure_current()?;
            tokio::time::sleep(limits.poll).await;
        }
        #[allow(unreachable_code)]
        Ok::<Value, String>(Value::Null)
    };
    let result = tokio::time::timeout(limits.total, async {
        match select(Box::pin(work), Box::pin(cancellation)).await {
            Either::Left((result, _)) | Either::Right((result, _)) => result,
        }
    })
    .await
    .map_err(|_| TIMEOUT.to_string())?;
    // Cancellation wins over even an error response that just finished reading.
    ensure_current()?;
    result
}

async fn read_bounded(mut response: reqwest::Response, cap: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > cap as u64)
    {
        return Err(TOO_LARGE.to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        if error.is_timeout() {
            TIMEOUT
        } else {
            INVALID_RESPONSE
        }
        .to_string()
    })? {
        if chunk.len() > cap.saturating_sub(bytes.len()) {
            return Err(TOO_LARGE.to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn safe_status_error(status: StatusCode) -> String {
    format!("Supabase authentication failed (HTTP {}).", status.as_u16())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc,
    };
    use std::thread;

    struct Server {
        url: String,
        stop: mpsc::Sender<()>,
        stop_flag: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
        calls: Arc<AtomicUsize>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop_flag.store(true, Ordering::SeqCst);
            let _ = self.stop.send(());
            let stopped = self.thread.take().expect("server thread").join();
            if !thread::panicking() {
                stopped.expect("server stop");
            }
        }
    }

    fn server<F>(mut respond: F) -> Server
    where
        F: FnMut(&mut TcpStream, &mpsc::Receiver<()>) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("anonymous loopback");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let url = format!("http://{}", listener.local_addr().expect("bound address"));
        let (stop, stopped) = mpsc::channel();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stopping = stop_flag.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let accepted = calls.clone();
        let thread = thread::spawn(move || loop {
            if stopping.load(Ordering::SeqCst) {
                break;
            }
            match stopped.try_recv() {
                Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
                Err(mpsc::TryRecvError::Empty) => {}
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    accepted.fetch_add(1, Ordering::SeqCst);
                    // macOS inherits O_NONBLOCK from the listener on accept.
                    stream
                        .set_nonblocking(false)
                        .expect("blocking fixture stream");
                    stream
                        .set_read_timeout(Some(Duration::from_millis(500)))
                        .expect("read bound");
                    stream
                        .set_write_timeout(Some(Duration::from_millis(500)))
                        .expect("write bound");
                    respond(&mut stream, &stopped);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("loopback accept: {error}"),
            }
        });
        Server {
            url,
            stop,
            stop_flag,
            thread: Some(thread),
            calls,
        }
    }

    fn read_request(stream: &mut TcpStream) {
        let mut bytes = [0; 2048];
        let _ = stream.read(&mut bytes).expect("test request");
    }

    fn response(status: u16, body: &[u8], content_length: bool) -> Server {
        let mut bytes = format!("HTTP/1.1 {status} Test\r\nConnection: close\r\n").into_bytes();
        if content_length {
            bytes.extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes());
        }
        bytes.extend_from_slice(b"\r\n");
        bytes.extend_from_slice(body);
        server(move |stream, _| {
            read_request(stream);
            let _ = stream.write_all(&bytes);
        })
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
    }

    fn limits() -> AuthLimits {
        AuthLimits {
            connect: Duration::from_millis(50),
            attempt: Duration::from_millis(150),
            total: Duration::from_millis(300),
            poll: Duration::from_millis(5),
            backoff: Duration::from_millis(5),
            success_bytes: 256,
            error_bytes: 32,
        }
    }

    async fn request(
        server: &Server,
        operation: AuthOperation,
        limits: AuthLimits,
    ) -> Result<Value, String> {
        request_auth_with_limits(
            &server.url,
            "public-fixture",
            &serde_json::json!({
                "email": "fixture@example.invalid", "password": "fixture-secret"
            }),
            operation,
            || Ok(()),
            limits,
        )
        .await
    }

    #[test]
    fn normal_session_and_confirmation_responses_are_returned() {
        for body in [
            b"{\"access_token\":\"fixture\",\"user\":{\"id\":\"a\"}}".as_slice(),
            b"{\"user\":{\"id\":\"a\"}}",
        ] {
            let fixture = response(200, body, true);
            let value = runtime()
                .block_on(request(&fixture, AuthOperation::SignUp, limits()))
                .expect("valid JSON");
            assert_eq!(value["user"]["id"], "a");
            assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn response_headers_and_body_stalls_are_bounded() {
        for headers in [false, true] {
            let fixture = server(move |stream, stopped| {
                read_request(stream);
                if headers {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                        .expect("partial response");
                }
                let _ = stopped.recv_timeout(Duration::from_secs(1));
            });
            let started = std::time::Instant::now();
            let error = runtime()
                .block_on(request(&fixture, AuthOperation::SignIn, limits()))
                .expect_err("bounded stall");
            assert_eq!(error, TIMEOUT);
            assert!(started.elapsed() < Duration::from_secs(1));
            assert_eq!(
                fixture.calls.load(Ordering::SeqCst),
                1,
                "no ambiguous timeout replay"
            );
        }
    }

    #[test]
    fn tls_connection_handshake_is_bounded() {
        let mut fixture = server(|_, stopped| {
            let _ = stopped.recv_timeout(Duration::from_secs(1));
        });
        fixture.url = fixture.url.replacen("http:", "https:", 1);
        let error = runtime()
            .block_on(request(&fixture, AuthOperation::SignIn, limits()))
            .expect_err("TLS handshake hangs");
        assert_eq!(error, TIMEOUT);
        assert_eq!(
            fixture.calls.load(Ordering::SeqCst),
            1,
            "connect timeout is not replayed"
        );
    }

    #[test]
    fn total_deadline_limits_send_and_body_even_when_attempt_budget_is_larger() {
        for headers in [false, true] {
            let fixture = server(move |stream, stopped| {
                read_request(stream);
                if headers {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{")
                        .expect("headers");
                }
                let _ = stopped.recv_timeout(Duration::from_secs(1));
            });
            let mut settings = limits();
            settings.attempt = Duration::from_secs(2);
            settings.total = Duration::from_millis(50);
            let error = runtime()
                .block_on(request(&fixture, AuthOperation::SignIn, settings))
                .expect_err("total budget wins");
            assert_eq!(error, TIMEOUT);
        }
    }

    #[test]
    fn success_and_error_bodies_with_and_without_length_are_capped() {
        for status in [200, 400] {
            for length in [false, true] {
                let cap = if status == 200 {
                    limits().success_bytes
                } else {
                    limits().error_bytes
                };
                let fixture = response(status, &vec![b'x'; cap + 1], length);
                assert_eq!(
                    runtime()
                        .block_on(request(&fixture, AuthOperation::SignIn, limits()))
                        .expect_err("cap rejects"),
                    TOO_LARGE
                );
            }
        }
    }

    #[test]
    fn malformed_and_error_responses_do_not_expose_body_or_credentials() {
        for status in [200, 401, 500] {
            let fixture = response(status, b"fixture-secret", true);
            let error = runtime()
                .block_on(request(&fixture, AuthOperation::SignUp, limits()))
                .expect_err("bad response");
            assert!(!error.contains("fixture-secret"));
            assert!(!error.contains("fixture@example.invalid"));
            assert!(!error.contains(&fixture.url));
            assert_eq!(
                fixture.calls.load(Ordering::SeqCst),
                1,
                "signup never replays a response"
            );
        }
    }

    #[test]
    fn auth_redirect_never_sends_credentials_to_destination() {
        let destination = response(200, b"{}", true);
        let location = destination.url.clone();
        let fixture = server(move |stream, _| {
            read_request(stream);
            stream.write_all(format!("HTTP/1.1 307 Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n").as_bytes()).expect("redirect");
        });
        let error = runtime()
            .block_on(request(&fixture, AuthOperation::SignIn, limits()))
            .expect_err("redirect rejected");
        assert_eq!(error, "Supabase authentication failed (HTTP 307).");
        assert_eq!(destination.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn invalidated_generation_cancels_header_and_body_waits() {
        for headers in [false, true] {
            let current = Arc::new(AtomicBool::new(true));
            let invalidated = current.clone();
            let fixture = server(move |stream, stopped| {
                read_request(stream);
                if headers {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{")
                        .expect("headers");
                }
                invalidated.store(false, Ordering::SeqCst);
                let _ = stopped.recv_timeout(Duration::from_secs(1));
            });
            let error = runtime()
                .block_on(request_auth_with_limits(
                    &fixture.url,
                    "fixture",
                    &serde_json::json!({}),
                    AuthOperation::SignIn,
                    || {
                        if current.load(Ordering::SeqCst) {
                            Ok(())
                        } else {
                            Err(super::super::SESSION_OPERATION_SUPERSEDED.to_string())
                        }
                    },
                    limits(),
                ))
                .expect_err("cancel pending read");
            assert_eq!(error, super::super::SESSION_OPERATION_SUPERSEDED);
        }
    }

    #[test]
    fn retry_backoff_cannot_escape_total_deadline_or_signup_safety() {
        // A closed port may take longer than the budget to fail on Windows.
        // Reject a TLS ClientHello on an owned port instead: authentication
        // credentials cannot be sent before the handshake succeeds.
        for operation in [AuthOperation::SignIn, AuthOperation::SignUp] {
            let mut fixture = server(|stream, _| {
                let mut hello = [0; 5];
                stream.read_exact(&mut hello).expect("TLS record header");
                assert!(hello[0] == 22, "only a TLS handshake reaches the fixture");
                // TLS fatal handshake_failure alert (before any application data).
                stream
                    .write_all(&[21, 3, 3, 0, 2, 2, 40])
                    .expect("reject TLS handshake");
            });
            fixture.url = fixture.url.replacen("http:", "https:", 1);
            let mut settings = limits();
            settings.connect = Duration::from_millis(500);
            settings.attempt = Duration::from_millis(500);
            settings.total = Duration::from_millis(500);
            settings.backoff = Duration::from_secs(2);
            let started = std::time::Instant::now();
            let error = runtime()
                .block_on(request_auth_with_limits(
                    &fixture.url,
                    "fixture",
                    &serde_json::json!({}),
                    operation,
                    || Ok(()),
                    settings,
                ))
                .expect_err("handshake refused before sending credentials");
            let expected = if matches!(operation, AuthOperation::SignIn) {
                TIMEOUT
            } else {
                NETWORK
            };
            assert_eq!(error, expected, "only login enters the bounded retry");
            assert!(
                started.elapsed() < Duration::from_secs(1),
                "the total deadline interrupts the two-second backoff"
            );
            assert_eq!(
                fixture.calls.load(Ordering::SeqCst),
                1,
                "no replay after the deadline or during signup"
            );
        }
    }
}
