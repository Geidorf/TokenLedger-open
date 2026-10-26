use super::*;
use crate::gateway::MemorySecrets;
use std::collections::HashMap;
use std::io::Write;
use std::sync::Barrier;

static COUNTER: AtomicUsize = AtomicUsize::new(0);
const PLAINTEXT_SENTINEL: &str = "content-sampling-plaintext-sentinel";

fn gateway_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_content_sampling_{}_{}_{name}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    path
}

fn memory_sampling(name: &str) -> (PathBuf, Arc<ContentSampling>, Arc<MemorySecrets>) {
    let root = gateway_dir(name);
    let secrets = Arc::new(MemorySecrets::default());
    let sampling = Arc::new(ContentSampling::new(&root, secrets.clone()));
    (root, sampling, secrets)
}

fn next(count: u32, confirmed: bool) -> SamplingInput {
    SamplingInput {
        mode: SamplingMode::Next,
        count: Some(count),
        confirmed,
        ..SamplingInput::default()
    }
}

fn filter(agent: &str, failures_only: bool, hours: u32) -> SamplingInput {
    SamplingInput {
        mode: SamplingMode::Filter,
        agent: Some(agent.to_string()),
        failures_only,
        duration_hours: Some(hours),
        confirmed: true,
        ..SamplingInput::default()
    }
}

fn captured(text: &str) -> CapturedContent {
    CapturedContent {
        text: text.to_string(),
        truncated: false,
        failed: false,
    }
}

fn id(number: usize) -> String {
    format!("{number:016x}")
}

fn begin_and_finish(
    sampling: &ContentSampling,
    sample_id: &str,
    request: &str,
    response: &str,
    status: u16,
) {
    let ticket = sampling
        .begin(sample_id, None, None, false, captured(request))
        .expect("sample ticket");
    sampling
        .finish(ticket, captured(response), status, false)
        .expect("store sample");
}

fn fake_sample(root: &Path, sample_id: &str, created_at: i64, length: u64) {
    let directory = root.join(SAMPLE_DIRECTORY);
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{sample_id}.bin"));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .unwrap();
    file.write_all(MAGIC).unwrap();
    file.write_all(&created_at.to_be_bytes()).unwrap();
    file.write_all(&[0u8; 12]).unwrap();
    file.set_len(length.max(HEADER_BYTES as u64)).unwrap();
}

fn sample_files(root: &Path) -> Vec<PathBuf> {
    let directory = root.join(SAMPLE_DIRECTORY);
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("bin"))
        .collect()
}

#[test]
fn sampling_is_off_until_confirmed_and_never_creates_a_key_by_status_alone() {
    let (root, sampling, secrets) = memory_sampling("default_off");

    let status = sampling.status();
    assert_eq!(status.mode, SamplingMode::Off);
    assert!(secrets.get(KEY_ACCOUNT).unwrap().is_none());
    assert!(!root.join(SAMPLE_DIRECTORY).exists());

    assert!(sampling.configure(next(3, false)).is_err());
    assert_eq!(sampling.status().mode, SamplingMode::Off);
    assert!(secrets.get(KEY_ACCOUNT).unwrap().is_none());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn concurrent_next_requests_never_exceed_the_configured_count() {
    let (root, sampling, _) = memory_sampling("concurrent_next");
    assert_eq!(
        sampling.configure(next(8, true)).unwrap().mode,
        SamplingMode::Next
    );

    let barrier = Arc::new(Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|number| {
            let sampling = Arc::clone(&sampling);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                let Some(ticket) =
                    sampling.begin(&id(number), None, None, false, captured("request"))
                else {
                    return 0;
                };
                sampling
                    .finish(ticket, captured("response"), 200, false)
                    .expect("store accepted sample");
                1
            })
        })
        .collect();
    let accepted: usize = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .sum();
    assert!((1..=8).contains(&accepted));
    let status = sampling.status();
    assert_eq!(status.stored_count, accepted);
    assert_eq!(status.remaining.unwrap_or(0) as usize, 8 - accepted);

    for number in 8..16 - accepted {
        begin_and_finish(&sampling, &id(number), "request", "response", 200);
    }

    let status = sampling.status();
    assert_eq!(status.mode, SamplingMode::Off);
    assert_eq!(status.stored_count, 8);
    assert!(sampling
        .begin(&id(16), None, None, false, captured("late"))
        .is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn restart_requires_status_and_resumes_the_persisted_next_count() {
    let (root, first, secrets) = memory_sampling("restart_next");
    assert_eq!(first.configure(next(3, true)).unwrap().remaining, Some(3));
    let abandoned = first
        .begin(&id(0), None, None, false, captured("request"))
        .expect("ticket");
    drop(abandoned);
    assert_eq!(first.status().remaining, Some(2));

    let restarted = ContentSampling::new(&root, secrets);
    assert!(restarted
        .begin(&id(1), None, None, false, captured("before status"))
        .is_none());
    let status = restarted.status();
    assert_eq!(status.mode, SamplingMode::Next);
    assert_eq!(status.remaining, Some(2));

    begin_and_finish(&restarted, &id(1), "request", "response", 200);
    begin_and_finish(&restarted, &id(2), "request", "response", 200);
    assert_eq!(restarted.status().mode, SamplingMode::Off);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn manual_off_and_delete_invalidate_late_finish_results() {
    let (root, sampling, _) = memory_sampling("late_finish");
    sampling.configure(next(2, true)).unwrap();
    let ticket = sampling
        .begin(&id(0), None, None, false, captured("request"))
        .unwrap();
    sampling
        .configure(SamplingInput {
            mode: SamplingMode::Off,
            delete_existing: Some(false),
            ..SamplingInput::default()
        })
        .unwrap();
    sampling
        .finish(ticket, captured("response"), 200, false)
        .unwrap();
    assert_eq!(sampling.status().stored_count, 0);

    sampling.configure(next(2, true)).unwrap();
    let ticket = sampling
        .begin(&id(1), None, None, false, captured("request"))
        .unwrap();
    sampling.delete(None).unwrap();
    sampling
        .finish(ticket, captured("response"), 200, false)
        .unwrap();
    assert_eq!(sampling.status().stored_count, 0);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn queued_reservations_cannot_use_a_later_authorization() {
    let (root, sampling, _) = memory_sampling("queued_reservation");
    sampling.configure(next(2, true)).unwrap();
    let slot = sampling.reserve().unwrap();
    sampling.configure(SamplingInput::default()).unwrap();
    sampling.configure(next(2, true)).unwrap();
    assert!(sampling
        .begin_reserved(slot, &id(0), None, None, false, captured("old request"))
        .is_none());
    assert_eq!(sampling.status().remaining, Some(2));
    assert_eq!(sampling.pending_count(), 0);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn persistence_failure_disables_sampling_and_invalidates_pending_tickets() {
    let (root, sampling, _) = memory_sampling("storage_failure");
    sampling.configure(next(3, true)).unwrap();
    let ticket = sampling
        .begin(&id(0), None, None, false, captured("request"))
        .unwrap();
    let directory = root.join(SAMPLE_DIRECTORY);
    fs::remove_dir(&directory).unwrap();
    fs::write(&directory, b"unavailable directory fixture").unwrap();

    assert!(sampling
        .begin(&id(1), None, None, false, captured("request"))
        .is_none());
    assert!(!sampling.active());
    fs::remove_file(&directory).unwrap();
    fs::create_dir(&directory).unwrap();
    sampling
        .finish(ticket, captured("late response"), 200, false)
        .unwrap();
    assert_eq!(sampling.status().stored_count, 0);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn the_last_reserved_next_ticket_can_still_finish_after_auto_off() {
    let (root, sampling, _) = memory_sampling("last_next");
    sampling.configure(next(1, true)).unwrap();
    let ticket = sampling
        .begin(&id(0), None, None, true, captured("request-body"))
        .unwrap();
    assert_eq!(sampling.status().mode, SamplingMode::Off);
    sampling
        .finish(ticket, captured("response-body"), 200, false)
        .unwrap();

    let sample = sampling.read(&id(0)).unwrap();
    assert!(sample.stream);
    assert_eq!(sample.status, 200);
    assert_eq!(sampling.status().stored_count, 1);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn filter_only_keeps_failures_and_incomplete_results() {
    let (root, sampling, _) = memory_sampling("filter_failures");
    sampling.configure(filter("agent-a", true, 1)).unwrap();
    assert!(sampling
        .begin(&id(0), Some("agent-b"), None, false, captured("request"))
        .is_none());

    let ticket = sampling
        .begin(&id(0), Some("agent-a"), None, false, captured("request"))
        .unwrap();
    sampling
        .finish(ticket, captured("success"), 200, false)
        .unwrap();
    assert_eq!(sampling.status().stored_count, 0);

    let ticket = sampling
        .begin(&id(1), Some("agent-a"), None, false, captured("request"))
        .unwrap();
    sampling
        .finish(ticket, captured("failure"), 500, false)
        .unwrap();

    let ticket = sampling
        .begin(&id(2), Some("agent-a"), None, true, captured("request"))
        .unwrap();
    sampling
        .finish(ticket, captured("incomplete"), 200, true)
        .unwrap();

    let ticket = sampling
        .begin(&id(3), Some("agent-a"), None, false, captured("request"))
        .unwrap();
    sampling
        .finish(
            ticket,
            CapturedContent {
                text: "failed capture".to_string(),
                truncated: false,
                failed: true,
            },
            200,
            false,
        )
        .unwrap();

    let status = sampling.status();
    assert_eq!(status.stored_count, 3);
    assert!(status.sample_ids.contains(&id(1)));
    assert!(status.sample_ids.contains(&id(2)));
    assert!(status.sample_ids.contains(&id(3)));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn expired_filter_turns_off_on_status_even_after_restart() {
    let root = gateway_dir("expired_filter");
    fs::create_dir_all(&root).unwrap();
    let configuration = Configuration {
        mode: SamplingMode::Filter,
        expires_at: Some(Utc::now().timestamp() - 1),
        agent: Some("agent-a".to_string()),
        ..Configuration::default()
    };
    fs::write(
        root.join(STATE_FILE),
        serde_json::to_vec(&configuration).unwrap(),
    )
    .unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let sampling = ContentSampling::new(&root, secrets);

    let status = sampling.status();
    assert_eq!(status.mode, SamplingMode::Off);
    assert!(status.error.is_none());
    assert_eq!(
        serde_json::from_slice::<Configuration>(&fs::read(root.join(STATE_FILE)).unwrap())
            .unwrap()
            .mode,
        SamplingMode::Off
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn filter_requires_a_condition_and_stays_within_24_hours() {
    let (root, sampling, _) = memory_sampling("filter_bounds");
    let missing_condition = SamplingInput {
        mode: SamplingMode::Filter,
        duration_hours: Some(1),
        confirmed: true,
        ..SamplingInput::default()
    };
    assert!(sampling.configure(missing_condition).is_err());

    let too_long = filter("agent-a", false, 25);
    assert!(sampling.configure(too_long).is_err());

    let zero = filter("agent-a", false, 0);
    assert!(sampling.configure(zero).is_err());
    assert_eq!(sampling.status().mode, SamplingMode::Off);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn missing_wrong_length_and_unreadable_keys_fail_closed() {
    let (root, sampling, secrets) = memory_sampling("missing_key");
    sampling.configure(next(2, true)).unwrap();
    begin_and_finish(&sampling, &id(0), "request", "response", 200);
    secrets.delete(KEY_ACCOUNT).unwrap();
    let status = sampling.status();
    assert_eq!(status.mode, SamplingMode::Off);
    assert_eq!(status.error.as_deref(), Some(KEY_ERROR));
    assert!(sample_files(&root).is_empty());
    let _ = fs::remove_dir_all(root);

    let (root, sampling, secrets) = memory_sampling("wrong_length_key");
    secrets.set(KEY_ACCOUNT, "00").unwrap();
    assert_eq!(sampling.configure(next(1, true)).err().unwrap(), KEY_ERROR);
    assert_eq!(sampling.status().mode, SamplingMode::Off);
    assert!(sample_files(&root).is_empty());
    let _ = fs::remove_dir_all(root);

    let root = gateway_dir("unreadable_key");
    let secrets = Arc::new(UnreadableSecrets::default());
    let sampling = ContentSampling::new(&root, secrets.clone());
    sampling.configure(next(1, true)).unwrap();
    begin_and_finish(&sampling, &id(0), "request", "response", 200);
    secrets.unreadable.store(true, Ordering::SeqCst);
    let status = sampling.status();
    assert_eq!(status.mode, SamplingMode::Off);
    assert_eq!(status.error.as_deref(), Some(KEY_ERROR));
    assert!(sample_files(&root).is_empty());
    let _ = fs::remove_dir_all(root);
}

#[derive(Default)]
struct UnreadableSecrets {
    values: Mutex<HashMap<String, String>>,
    unreadable: AtomicBool,
}

impl SecretStore for UnreadableSecrets {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        if self.unreadable.load(Ordering::SeqCst) {
            return Err("test keychain unavailable".to_string());
        }
        Ok(self.values.lock().unwrap().get(account).cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.values
            .lock()
            .unwrap()
            .insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.values.lock().unwrap().remove(account);
        Ok(())
    }
}

#[test]
fn ciphertext_and_sample_exchange_fail_without_returning_plaintext() {
    let (root, sampling, _) = memory_sampling("ciphertext_swap");
    sampling.configure(filter("agent-a", false, 1)).unwrap();
    let ticket = sampling
        .begin(
            &id(0),
            Some("agent-a"),
            None,
            false,
            captured(PLAINTEXT_SENTINEL),
        )
        .unwrap();
    sampling
        .finish(ticket, captured(PLAINTEXT_SENTINEL), 500, false)
        .unwrap();

    let path = root.join(SAMPLE_DIRECTORY).join(format!("{}.bin", id(0)));
    let mut bytes = fs::read(&path).unwrap();
    assert!(!bytes
        .windows(PLAINTEXT_SENTINEL.len())
        .any(|window| window == PLAINTEXT_SENTINEL.as_bytes()));
    *bytes.last_mut().unwrap() ^= 0x80;
    fs::write(&path, bytes).unwrap();
    let error = sampling.read(&id(0)).err().unwrap();
    assert_eq!(error, READ_ERROR);
    assert!(!path.exists());

    for number in 1..=2 {
        let ticket = sampling
            .begin(
                &id(number),
                Some("agent-a"),
                None,
                false,
                captured("request"),
            )
            .unwrap();
        sampling
            .finish(ticket, captured("response"), 500, false)
            .unwrap();
    }
    let first = root.join(SAMPLE_DIRECTORY).join(format!("{}.bin", id(1)));
    let second = root.join(SAMPLE_DIRECTORY).join(format!("{}.bin", id(2)));
    let first_bytes = fs::read(&first).unwrap();
    let second_bytes = fs::read(&second).unwrap();
    fs::write(&first, second_bytes).unwrap();
    fs::write(&second, first_bytes).unwrap();

    assert_eq!(sampling.read(&id(1)).err().unwrap(), READ_ERROR);
    assert_eq!(sampling.read(&id(2)).err().unwrap(), READ_ERROR);
    assert!(!first.exists());
    assert!(!second.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn oversized_content_is_bounded_and_marked_truncated() {
    let (root, sampling, _) = memory_sampling("oversized");
    sampling.configure(next(1, true)).unwrap();
    let large = format!("{PLAINTEXT_SENTINEL}{}", "x".repeat(320 * 1024));
    begin_and_finish(&sampling, &id(0), &large, &large, 200);

    let path = root.join(SAMPLE_DIRECTORY).join(format!("{}.bin", id(0)));
    let bytes = fs::read(&path).unwrap();
    assert!(bytes.len() <= MAX_PLAINTEXT + HEADER_BYTES + CHACHA20_POLY1305.tag_len());
    assert!(!bytes
        .windows(PLAINTEXT_SENTINEL.len())
        .any(|window| window == PLAINTEXT_SENTINEL.as_bytes()));

    let sample = sampling.read(&id(0)).unwrap();
    assert!(sample.truncated);
    assert!(sample.request.len() <= CONTENT_BUDGET);
    assert!(sample.response.len() <= CONTENT_BUDGET);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn sample_count_cap_removes_the_oldest_sample() {
    let root = gateway_dir("count_cap");
    let now = Utc::now().timestamp();
    for number in 0..=MAX_SAMPLES {
        fake_sample(
            &root,
            &id(number),
            now - (MAX_SAMPLES as i64) + number as i64,
            64,
        );
    }
    let secrets = Arc::new(MemorySecrets::default());
    secrets.set(KEY_ACCOUNT, &"00".repeat(32)).unwrap();
    let sampling = ContentSampling::new(&root, secrets);

    let status = sampling.status();
    assert_eq!(status.stored_count, MAX_SAMPLES);
    assert!(!status.sample_ids.contains(&id(0)));
    assert!(status.sample_ids.contains(&id(MAX_SAMPLES)));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn disk_cap_removes_oldest_samples_and_keeps_total_bounded() {
    let root = gateway_dir("disk_cap");
    let now = Utc::now().timestamp();
    fake_sample(&root, &id(0), now, MAX_PLAINTEXT as u64 + 1);
    for number in 1..MAX_SAMPLES {
        fake_sample(&root, &id(number), now, MAX_PLAINTEXT as u64);
    }
    let secrets = Arc::new(MemorySecrets::default());
    let sampling = ContentSampling::new(&root, secrets);
    let mut inner = sampling.lock();
    let retained = sampling.maintain(&mut inner, now).unwrap();
    let total: u64 = retained.iter().map(|file| file.bytes).sum();
    assert_eq!(retained.len(), MAX_SAMPLES - 1);
    assert_eq!(total, MAX_PLAINTEXT as u64 * (MAX_SAMPLES as u64 - 1));
    assert!(total + MAX_PLAINTEXT as u64 + 1 > MAX_DISK_BYTES);
    assert!(!root
        .join(SAMPLE_DIRECTORY)
        .join(format!("{}.bin", id(0)))
        .exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn retention_keeps_the_exact_seven_day_boundary() {
    let root = gateway_dir("retention");
    let now = 2_000_000_000i64;
    fake_sample(&root, &id(0), now - RETENTION_SECONDS - 1, 64);
    fake_sample(&root, &id(1), now - RETENTION_SECONDS, 64);
    fake_sample(&root, &id(2), now + 60, 64);
    fake_sample(&root, &id(3), now + 61, 64);
    let secrets = Arc::new(MemorySecrets::default());
    let sampling = ContentSampling::new(&root, secrets);
    let mut inner = sampling.lock();

    let retained = sampling.maintain(&mut inner, now).unwrap();
    let retained: Vec<_> = retained.iter().map(|file| file.id.as_str()).collect();
    assert!(!retained.contains(&id(0).as_str()));
    assert!(retained.contains(&id(1).as_str()));
    assert!(retained.contains(&id(2).as_str()));
    assert!(!retained.contains(&id(3).as_str()));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn interrupted_sample_writes_are_removed_by_maintenance_and_stop() {
    let (root, sampling, _) = memory_sampling("interrupted_write");
    sampling.configure(next(2, true)).unwrap();
    let directory = root.join(SAMPLE_DIRECTORY);
    let temporary = directory.join(format!(".{}.bin.tokenledger-001122334455.tmp", id(0)));
    let unrelated = directory.join("unrelated.txt");
    fs::write(&unrelated, b"unrelated fixture").unwrap();
    fs::write(&temporary, b"interrupted encrypted sample fixture").unwrap();

    assert_eq!(sampling.status().stored_count, 0);
    assert!(!temporary.exists());
    fs::write(&temporary, b"interrupted encrypted sample fixture").unwrap();
    sampling.configure(SamplingInput::default()).unwrap();
    assert!(!temporary.exists());
    assert_eq!(fs::read(unrelated).unwrap(), b"unrelated fixture");
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn unix_directories_and_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let (root, sampling, _) = memory_sampling("unix_permissions");
    sampling.configure(next(1, true)).unwrap();
    begin_and_finish(&sampling, &id(0), "request", "response", 200);
    let directory = root.join(SAMPLE_DIRECTORY);
    let file = directory.join(format!("{}.bin", id(0)));
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&directory), 0o700);
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(&root.join(STATE_FILE)), 0o600);
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn symbolic_links_fail_closed_and_are_never_followed() {
    use std::os::unix::fs::symlink;

    let (root, sampling, _) = memory_sampling("file_symlink");
    sampling.configure(filter("agent-a", false, 1)).unwrap();
    let outside = root.join("outside.txt");
    fs::write(&outside, b"outside-content").unwrap();
    let linked = root.join(SAMPLE_DIRECTORY).join(format!("{}.bin", id(0)));
    symlink(&outside, &linked).unwrap();
    let status = sampling.status();
    assert_eq!(status.mode, SamplingMode::Off);
    assert_eq!(status.error.as_deref(), Some(STORE_ERROR));
    assert_eq!(fs::read(&outside).unwrap(), b"outside-content");
    assert!(fs::symlink_metadata(&linked)
        .unwrap()
        .file_type()
        .is_symlink());
    let _ = fs::remove_dir_all(root);

    let root = gateway_dir("directory_symlink");
    let outside = root.with_extension("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    symlink(&outside, root.join(SAMPLE_DIRECTORY)).unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let sampling = ContentSampling::new(&root, secrets);
    assert_eq!(
        sampling.configure(next(1, true)).err().unwrap(),
        STORE_ERROR
    );
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(outside);
}

#[test]
fn more_than_eight_pending_tickets_are_skipped_without_waiting() {
    let (root, sampling, _) = memory_sampling("pending_cap");
    sampling.configure(filter("agent-a", false, 1)).unwrap();
    let mut tickets = Vec::new();
    for number in 0..8 {
        tickets.push(
            sampling
                .begin(
                    &id(number),
                    Some("agent-a"),
                    None,
                    false,
                    captured("request"),
                )
                .unwrap(),
        );
    }
    assert!(sampling
        .begin(&id(8), Some("agent-a"), None, false, captured("request"),)
        .is_none());
    tickets.pop();
    assert!(sampling
        .begin(&id(8), Some("agent-a"), None, false, captured("request"),)
        .is_some());

    let guard = sampling.lock();
    assert!(sampling
        .begin(&id(9), Some("agent-a"), None, false, captured("request"),)
        .is_none());
    drop(guard);
    assert!(sampling
        .status()
        .error
        .as_deref()
        .is_some_and(|error| error.contains("繁忙")));
    let _ = fs::remove_dir_all(root);
}
