//! Durable multi-file transactions. Before-images include config, backups and
//! manifest; an uncommitted journal rolls back, a committed journal replays.
//! Recovery accepts only known before/after bytes and never overwrites drift.
use super::super::codex_config::{atomic_write, create_dir_durable, sync_dir};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const JOURNAL: &str = "transaction-v1.json";
const COMMIT: &str = "transaction-v1.commit";
static LOCK: Mutex<()> = Mutex::new(());
pub(crate) fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Change {
    pub path: PathBuf,
    pub before: Option<Vec<u8>>,
    pub after: Option<Vec<u8>>,
}
impl Change {
    pub fn new(path: PathBuf, before: Option<Vec<u8>>, after: Option<Vec<u8>>) -> Self {
        Self {
            path,
            before,
            after,
        }
    }
}
#[derive(Serialize, Deserialize)]
struct Journal {
    schema: u8,
    phase: String,
    changes: Vec<Change>,
}
pub(crate) fn read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取事务目标失败：{e}")),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            Err("事务目标是符号链接或不是普通文件，未做改动。".into())
        }
        Ok(meta) if meta.len() > 32 * 1024 * 1024 => Err("事务目标超过安全大小，未做改动。".into()),
        Ok(_) => fs::read(path)
            .map(Some)
            .map_err(|e| format!("读取事务目标失败：{e}")),
    }
}
fn put(
    path: &Path,
    bytes: Option<&[u8]>,
    expected: Option<&[u8]>,
    inject_fault: bool,
) -> Result<(), String> {
    let guard = || {
        if read(path)?.as_deref() == expected {
            if inject_fault {
                fault_replace()?;
            }
            Ok(())
        } else {
            Err("配置刚被其他程序修改，事务未完成，请重新检查。".into())
        }
    };
    match bytes {
        Some(bytes) => atomic_write(path, bytes, guard),
        None => {
            guard()?;
            match fs::remove_file(path) {
                Ok(()) => sync_dir(path.parent().ok_or("目标缺少父目录")?),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("删除事务目标失败：{e}")),
            }
        }
    }
}
fn temporary(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .ok_or("事务目标缺少文件名")?
        .to_string_lossy();
    Ok(path.with_file_name(format!(".{name}.tokenledger-transaction.tmp")))
}
fn stage(change: &Change) -> Result<(), String> {
    let Some(bytes) = &change.after else {
        return Ok(());
    };
    let path = temporary(&change.path)?;
    let dir = path.parent().ok_or("事务目标缺少父目录")?;
    create_dir_durable(dir)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("创建事务临时文件失败：{e}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("持久化事务临时文件失败：{e}"))?;
    sync_dir(dir)
}
fn remove_staged(changes: &[Change]) -> Result<(), String> {
    for c in changes {
        let tmp = temporary(&c.path)?;
        if read(&tmp)?.is_some() {
            fs::remove_file(&tmp).map_err(|e| format!("清理事务临时文件失败：{e}"))?;
            sync_dir(tmp.parent().ok_or("临时路径缺少父目录")?)?;
        }
    }
    Ok(())
}
fn cleanup(dir: &Path) -> Result<(), String> {
    // Remove the journal first: a leftover marker without a journal is harmless.
    for name in [JOURNAL, COMMIT] {
        match fs::remove_file(dir.join(name)) {
            Ok(()) => sync_dir(dir)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("清理事务记录失败：{e}")),
        }
    }
    Ok(())
}
/// Cheap startup gate: unrelated user configuration is not opened unless an
/// application-owned transaction journal or commit marker exists.
pub(crate) fn pending(dir: &Path) -> Result<bool, String> {
    Ok(read(&dir.join(JOURNAL))?.is_some() || read(&dir.join(COMMIT))?.is_some())
}
/// Caller holds lock. The allowed list comes from the Agent spec, never journal.
pub(crate) fn recover(dir: &Path, allowed: &[PathBuf]) -> Result<(), String> {
    let Some(bytes) = read(&dir.join(JOURNAL))? else {
        if read(&dir.join(COMMIT))?.is_some() {
            cleanup(dir)?;
        }
        return Ok(());
    };
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|_| "配置事务记录损坏；保留记录和备份，未覆盖任何配置。".to_string())?;
    if journal.schema != 1
        || journal.phase != "prepared"
        || journal.changes.len() > allowed.len()
        || journal.changes.iter().any(|c| !allowed.contains(&c.path))
        || journal
            .changes
            .iter()
            .enumerate()
            .any(|(i, c)| journal.changes[..i].iter().any(|x| x.path == c.path))
    {
        return Err("配置事务记录与当前目标不匹配；保留记录和备份。".into());
    }
    let committed = match read(&dir.join(COMMIT))? {
        Some(marker) if marker == super::super::codex_config::version(Some(&bytes)).as_bytes() => {
            true
        }
        Some(_) => return Err("配置事务提交标记损坏；保留记录和备份。".into()),
        None => false,
    };
    // Preflight every target before rollback/replay: external edits stay intact.
    let current: Vec<_> = journal
        .changes
        .iter()
        .map(|c| read(&c.path))
        .collect::<Result<_, _>>()?;
    if journal
        .changes
        .iter()
        .zip(&current)
        .any(|(c, b)| b != &c.before && b != &c.after)
    {
        return Err(
            "未完成的配置事务遇到外部修改；已保留原配置、事务记录与备份，请先处理冲突。".into(),
        );
    }
    remove_staged(&journal.changes)?;
    let order: Vec<usize> = if committed {
        (0..journal.changes.len()).collect()
    } else {
        (0..journal.changes.len()).rev().collect()
    };
    for i in order {
        let c = &journal.changes[i];
        let desired = if committed { &c.after } else { &c.before };
        if &current[i] != desired {
            put(&c.path, desired.as_deref(), current[i].as_deref(), false)?;
        }
    }
    cleanup(dir)
}
/// All targets are CAS checked before any mutation. Before-images are durable
/// before the first replacement, and the durable marker is the commit point.
pub(crate) fn execute(dir: &Path, changes: Vec<Change>) -> Result<(), String> {
    if changes.len() > 128
        || changes.iter().enumerate().any(|(i, c)| {
            c.path == dir.join(JOURNAL)
                || c.path == dir.join(COMMIT)
                || changes[..i].iter().any(|other| other.path == c.path)
        })
    {
        return Err("配置事务目标重复或无效，未做改动。".into());
    }
    let allowed: Vec<_> = changes.iter().map(|c| c.path.clone()).collect();
    if read(&dir.join(JOURNAL))?.is_some() || read(&dir.join(COMMIT))?.is_some() {
        return Err("仍有未清理的配置事务，请先检查恢复。".into());
    }
    for c in &changes {
        if read(&temporary(&c.path)?)?.is_some() {
            return Err("存在尚未归属的事务临时文件，保留文件且未做改动。".into());
        }
        if read(&c.path)? != c.before {
            return Err("配置在预检前被修改，未做改动，请重新预览。".into());
        }
    }
    let journal = Journal {
        schema: 1,
        phase: "prepared".into(),
        changes,
    };
    let body = serde_json::to_vec(&journal).map_err(|e| e.to_string())?;
    atomic_write(&dir.join(JOURNAL), &body, || Ok(()))?;
    checkpoint("prepared")?;
    let result: Result<(), String> = (|| {
        for c in &journal.changes {
            if c.before != c.after {
                stage(c)?;
            }
        }
        checkpoint("staged")?;
        // A second global CAS after staging catches drift before any target changes.
        for c in &journal.changes {
            if read(&c.path)? != c.before {
                return Err("配置在暂存后被修改，未开始替换。".into());
            }
        }
        for (i, c) in journal.changes.iter().enumerate() {
            if c.before == c.after {
                continue;
            }
            if c.after.is_some() {
                if read(&c.path)? != c.before {
                    return Err("配置在替换前被修改。".into());
                }
                fault_replace()?;
                fs::rename(temporary(&c.path)?, &c.path)
                    .map_err(|e| format!("替换事务目标失败：{e}"))?;
                sync_dir(c.path.parent().ok_or("目标缺少父目录")?)?;
            } else {
                put(&c.path, None, c.before.as_deref(), true)?;
            }
            checkpoint(&format!("written:{i}"))?;
        }
        checkpoint("before-commit")?;
        atomic_write(
            &dir.join(COMMIT),
            super::super::codex_config::version(Some(&body)).as_bytes(),
            || Ok(()),
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        return match recover(dir, &allowed) {
            Ok(()) => Err(format!("配置事务失败，已恢复一致状态：{error}")),
            Err(recovery) => Err(format!("配置事务失败：{error}；{recovery}")),
        };
    }
    checkpoint("committed")?;
    // A cleanup failure cannot turn an already committed transaction into a
    // failed apply. Its marker permits safe replay on the next inspection.
    let _ = remove_staged(&journal.changes).and_then(|_| cleanup(dir));
    Ok(())
}
#[cfg(not(test))]
fn checkpoint(_: &str) -> Result<(), String> {
    Ok(())
}
#[cfg(not(test))]
fn fault_replace() -> Result<(), String> {
    Ok(())
}
#[cfg(test)]
thread_local! {
    static EXIT_CRASH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAULT: std::cell::RefCell<(usize, usize, Option<String>)> = const { std::cell::RefCell::new((0,0,None)) };
}
#[cfg(test)]
pub(crate) fn inject(nth: usize, crash: Option<&str>) {
    FAULT.with(|f| *f.borrow_mut() = (nth, 0, crash.map(str::to_string)));
}
#[cfg(test)]
pub(crate) fn inject_exit(phase: &str) {
    inject(0, Some(phase));
    EXIT_CRASH.with(|v| v.set(true));
}
#[cfg(test)]
fn fault_replace() -> Result<(), String> {
    FAULT.with(|f| {
        let mut f = f.borrow_mut();
        f.1 += 1;
        if f.0 > 0 && f.0 == f.1 {
            f.0 = 0;
            Err("注入第 N 次 rename 失败".into())
        } else {
            Ok(())
        }
    })
}
#[cfg(test)]
fn checkpoint(phase: &str) -> Result<(), String> {
    let crash = FAULT.with(|f| f.borrow().2.as_deref() == Some(phase));
    if crash {
        if EXIT_CRASH.with(|v| v.get()) {
            std::process::exit(99);
        }
        panic!("注入崩溃：{phase}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn before_images_and_staged_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("tl-transaction-private-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config");
        fs::write(&config, b"secret-before").unwrap();
        fs::set_permissions(&config, fs::Permissions::from_mode(0o644)).unwrap();
        let journal = dir.join("backup");
        inject(0, Some("staged"));
        assert!(std::panic::catch_unwind(|| execute(
            &journal,
            vec![Change::new(
                config.clone(),
                Some(b"secret-before".to_vec()),
                Some(b"secret-after".to_vec())
            )]
        ))
        .is_err());
        inject(0, None);
        assert_eq!(
            fs::metadata(journal.join(JOURNAL))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(temporary(&config).unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&journal).unwrap().permissions().mode() & 0o777,
            0o700
        );
        recover(&journal, &[config.clone()]).unwrap();
        assert_eq!(fs::read(config).unwrap(), b"secret-before");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn all_target_cas_preflight_and_recovery_path_validation() {
        let dir =
            std::env::temp_dir().join(format!("tl-transaction-preflight-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a");
        let b = dir.join("b");
        fs::write(&a, b"before-a").unwrap();
        fs::write(&b, b"external-b").unwrap();
        let changes = vec![
            Change::new(
                a.clone(),
                Some(b"before-a".to_vec()),
                Some(b"after-a".to_vec()),
            ),
            Change::new(
                b.clone(),
                Some(b"before-b".to_vec()),
                Some(b"after-b".to_vec()),
            ),
        ];
        assert!(execute(&dir, changes.clone()).is_err());
        assert_eq!(fs::read(&a).unwrap(), b"before-a");
        assert_eq!(fs::read(&b).unwrap(), b"external-b");
        assert!(!dir.join(JOURNAL).exists());
        fs::write(
            dir.join(JOURNAL),
            serde_json::to_vec(&Journal {
                schema: 1,
                phase: "prepared".into(),
                changes,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(recover(&dir, &[a.clone()]).unwrap_err().contains("不匹配"));
        assert_eq!(fs::read(a).unwrap(), b"before-a");
        assert_eq!(fs::read(b).unwrap(), b"external-b");
        fs::remove_dir_all(dir).unwrap();
    }
}
