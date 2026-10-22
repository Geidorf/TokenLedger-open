//! Read-only view of the project index for the local behavior aggregation
//! (behavior contract v1.2; T10.182, spec PD-6).
//!
//! The behavior command only reads the index. One read transaction takes the
//! state row and, only while collection runs, every stored session outcome,
//! so the aggregation never pairs a state with a mapping from another moment
//! (for example “ready” with rows that a disable already purged). When the
//! dimension is off or the consent is outdated, no session row is read at
//! all. Only sanitized folder names, fixed groups and fixed codes leave this
//! module; the index holds no paths, and nothing here logs.

use super::label::{choose_display_label, project_key_for_label, ProjectKind, Resolution};
use super::store::{self, BackfillStatus};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::Path;

/// Where one session belongs, as stored in the index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionPlace {
    /// A named project or a fixed group: index into [`CollectingView::projects`].
    Project(usize),
    /// The source records no working directory (`unsupported_source`).
    UnsupportedSource,
    /// The source records one, but it could not be determined: the log was
    /// cleaned up or unreadable, the field was missing, the path was invalid
    /// or a read limit was hit.
    Unresolved,
}

/// One named project or fixed group, as the behavior contract shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProjectEntry {
    /// Opaque and stable, derived from the stored name only: `n:` + the
    /// lower-case folder name for named projects, `@home` / `@root` /
    /// `@temp` / `@managed` for fixed groups. Never a path or a hash.
    pub(crate) key: String,
    /// Named projects: the spelling most sessions of this key use across the
    /// whole index, ties broken by code-point order. Fixed groups: `None`.
    pub(crate) label: Option<String>,
    /// `named` | `home` | `root` | `temp` | `managed`.
    pub(crate) kind: &'static str,
}

/// The index while collection runs (`indexing`, `ready` or `failed`).
#[derive(Debug, Default)]
pub(crate) struct CollectingView {
    /// `indexing` | `ready` | `failed`, the words of `get_project_dimension_status`.
    pub(crate) state: &'static str,
    /// Only while `failed`: the fixed reason code of the failed backfill
    /// (`database_error` or `internal_error`). `None` for any other stored
    /// value, so nothing but these codes can reach the response.
    pub(crate) last_failure: Option<&'static str>,
    pub(crate) projects: Vec<ProjectEntry>,
    /// tool → session id → place; two levels so lookups can borrow `&str`.
    sessions: HashMap<String, HashMap<String, SessionPlace>>,
}

impl CollectingView {
    /// Stored place of one session; `None` when it has no index row yet
    /// (pending). The session id is the raw ledger value, as the index keys it.
    pub(crate) fn place(&self, tool: &str, session_id: &str) -> Option<SessionPlace> {
        self.sessions.get(tool)?.get(session_id).copied()
    }
}

/// The index as the behavior command sees it.
#[derive(Debug)]
pub(crate) enum ProjectIndexView {
    /// Not collecting: `disabled`, or `consent_required` (enabled under an
    /// older consent version). No project data may be shown.
    Off {
        state: &'static str,
    },
    On(CollectingView),
}

pub(crate) fn load(db_path: &Path) -> rusqlite::Result<ProjectIndexView> {
    let mut conn = crate::db::get_connection(db_path)?;
    load_from(&mut conn)
}

fn load_from(conn: &mut Connection) -> rusqlite::Result<ProjectIndexView> {
    // Deferred read transaction: both reads see the same snapshot. Dropping
    // it rolls back, which for reads changes nothing.
    let tx = conn.transaction()?;
    let state = store::load_state(&tx)?;
    let code = super::state_code(&state);
    if !state.collecting() {
        return Ok(ProjectIndexView::Off { state: code });
    }
    let mut view = CollectingView {
        state: code,
        last_failure: if state.backfill_status == BackfillStatus::Failed {
            failure_code(state.last_failure.as_deref())
        } else {
            None
        },
        ..CollectingView::default()
    };
    let mut entries: HashMap<String, usize> = HashMap::new();
    // Per named project: spelling → sessions using it.
    let mut spellings: HashMap<usize, HashMap<String, u64>> = HashMap::new();
    {
        // The stored `project_key` is not read: a named key is recomputed from
        // the stored name with the writer's own rule, so it can never carry
        // more than the name, even in a damaged or hand-edited index.
        let mut statement = tx.prepare(
            "SELECT tool, session_id, project_kind, project_label, resolution
             FROM local_session_projects",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let tool: String = row.get(0)?;
            let session_id: String = row.get(1)?;
            let kind = parse_kind(&row.get::<_, String>(2)?);
            let label: Option<String> = row.get(3)?;
            let resolution = Resolution::parse(&row.get::<_, String>(4)?);
            let place = match (kind, label) {
                (Some(ProjectKind::Named), Some(label)) => {
                    let key = project_key_for_label(&label);
                    let index = entry_index(&mut view.projects, &mut entries, key, "named");
                    *spellings
                        .entry(index)
                        .or_default()
                        .entry(label)
                        .or_insert(0) += 1;
                    SessionPlace::Project(index)
                }
                (
                    Some(
                        group @ (ProjectKind::Home
                        | ProjectKind::Root
                        | ProjectKind::Temp
                        | ProjectKind::Managed),
                    ),
                    _,
                ) => SessionPlace::Project(entry_index(
                    &mut view.projects,
                    &mut entries,
                    group.bucket_key().to_string(),
                    group.as_str(),
                )),
                // `unresolved` rows, and defensively any row that breaks the
                // table constraints: never shown as a project.
                _ if resolution == Some(Resolution::UnsupportedSource) => {
                    SessionPlace::UnsupportedSource
                }
                _ => SessionPlace::Unresolved,
            };
            view.sessions
                .entry(tool)
                .or_default()
                .insert(session_id, place);
        }
    }
    for (index, counts) in spellings {
        view.projects[index].label = choose_display_label(
            counts
                .iter()
                .map(|(spelling, sessions)| (spelling.as_str(), *sessions)),
        )
        .map(str::to_string);
    }
    Ok(ProjectIndexView::On(view))
}

fn parse_kind(value: &str) -> Option<ProjectKind> {
    [
        ProjectKind::Named,
        ProjectKind::Home,
        ProjectKind::Root,
        ProjectKind::Temp,
        ProjectKind::Managed,
        ProjectKind::Unresolved,
    ]
    .into_iter()
    .find(|kind| kind.as_str() == value)
}

fn entry_index(
    projects: &mut Vec<ProjectEntry>,
    entries: &mut HashMap<String, usize>,
    key: String,
    kind: &'static str,
) -> usize {
    *entries.entry(key.clone()).or_insert_with(|| {
        projects.push(ProjectEntry {
            key,
            label: None,
            kind,
        });
        projects.len() - 1
    })
}

/// The stored failure code when it is one of the fixed backfill codes.
fn failure_code(stored: Option<&str>) -> Option<&'static str> {
    [super::CODE_DATABASE, super::CODE_INTERNAL]
        .into_iter()
        .find(|code| stored == Some(*code))
}

/// Seeds the index through the store's own write path (consent and
/// generation guards included), so behavior tests never name its tables.
#[cfg(test)]
pub(crate) mod test_support {
    use super::super::label::{ProjectKind, ProjectRef, Resolution};
    use super::super::store::{self, BackfillStatus, SessionProject};
    use super::super::{effective_resolver_version, set_impl, PROJECT_DIMENSION_CONSENT_VERSION};
    use std::path::Path;

    /// One stored session outcome.
    #[derive(Clone, Copy, Debug)]
    pub(crate) enum Outcome<'a> {
        Named(&'a str),
        Home,
        Root,
        Temp,
        Managed,
        UnsupportedSource,
        /// Any other unresolved code, e.g. `source_missing` or `invalid_path`.
        Unresolved(&'a str),
    }

    impl Outcome<'_> {
        fn project(self) -> ProjectRef {
            match self {
                Self::Named(name) => {
                    ProjectRef::named(name, Resolution::Folder).expect("valid test folder name")
                }
                Self::Home => ProjectRef::bucket(ProjectKind::Home),
                Self::Root => ProjectRef::bucket(ProjectKind::Root),
                Self::Temp => ProjectRef::bucket(ProjectKind::Temp),
                Self::Managed => ProjectRef::bucket(ProjectKind::Managed),
                Self::UnsupportedSource => ProjectRef::unresolved(Resolution::UnsupportedSource),
                Self::Unresolved(code) => {
                    ProjectRef::unresolved(Resolution::parse(code).expect("known resolution code"))
                }
            }
        }
    }

    /// Turns collection on with the current consent (state `indexing`).
    pub(crate) fn enable(db_path: &Path) {
        set_impl(db_path, true, Some(PROJECT_DIMENSION_CONSENT_VERSION)).expect("enable index");
    }

    /// Turns collection off through the real command path (purges every row).
    pub(crate) fn disable(db_path: &Path) {
        set_impl(db_path, false, None).expect("disable index");
    }

    /// Stores outcomes under the current generation, as a pass would.
    pub(crate) fn store_sessions(db_path: &Path, rows: &[(&str, &str, Outcome<'_>)]) {
        let mut conn = store::open(db_path).expect("open index");
        let generation = store::load_state(&conn).expect("state").generation;
        let batch: Vec<SessionProject> = rows
            .iter()
            .map(|(tool, session_id, outcome)| SessionProject {
                tool: tool.to_string(),
                session_id: session_id.to_string(),
                source_family: "claude",
                project: outcome.project(),
            })
            .collect();
        assert!(
            store::write_batch(&mut conn, generation, effective_resolver_version(), &batch)
                .expect("write batch"),
            "the index must be collecting under the current generation"
        );
    }

    fn finish(db_path: &Path, status: BackfillStatus, failure: Option<&str>) {
        let mut conn = store::open(db_path).expect("open index");
        let state = store::load_state(&conn).expect("state");
        let through = store::max_log_id(&conn).expect("max id");
        assert!(store::update_progress(
            &mut conn,
            state.generation,
            status,
            0,
            0,
            Some((through, effective_resolver_version())),
            failure,
        )
        .expect("update progress"));
    }

    /// Backfill completed: state `ready`.
    pub(crate) fn mark_ready(db_path: &Path) {
        finish(db_path, BackfillStatus::Done, None);
    }

    /// Backfill failed with the stored `code`: state `failed`.
    pub(crate) fn mark_failed(db_path: &Path, code: &str) {
        finish(db_path, BackfillStatus::Failed, Some(code));
    }

    /// Re-confirms under an older consent version: collection pauses while
    /// the stored rows stay (state `consent_required`).
    pub(crate) fn downgrade_consent(db_path: &Path) {
        let mut conn = store::open(db_path).expect("open index");
        store::enable(&mut conn, PROJECT_DIMENSION_CONSENT_VERSION - 1).expect("older consent");
    }

    /// A restored or inconsistent database: the switch is off while rows
    /// are still stored. Nothing the app writes, but the view must hide them.
    pub(crate) fn switch_off_keeping_rows(db_path: &Path) {
        let conn = store::open(db_path).expect("open index");
        conn.execute(
            "UPDATE local_project_index_state SET enabled = 0 WHERE id = 1",
            [],
        )
        .expect("switch off");
    }

    /// A damaged or hand-edited index: a named row whose stored key is not
    /// derived from its name (review P3-2). Nothing the app writes.
    pub(crate) fn overwrite_stored_key(db_path: &Path, tool: &str, session_id: &str, key: &str) {
        let conn = store::open(db_path).expect("open index");
        let changed = conn
            .execute(
                "UPDATE local_session_projects SET project_key = ?3
                 WHERE tool = ?1 AND session_id = ?2",
                rusqlite::params![tool, session_id, key],
            )
            .expect("overwrite stored key");
        assert_eq!(changed, 1, "exactly one stored row");
    }

    /// Which index table a damaged database lacks.
    #[derive(Clone, Copy, Debug)]
    pub(crate) enum MissingTable {
        State,
        Sessions,
    }

    /// A damaged database whose index cannot be read (review P3-4): the
    /// table is renamed away, as in a restored copy that lacks it. `init_db`
    /// does not recreate it, because the schema version already says 13.
    pub(crate) fn hide_table(db_path: &Path, table: MissingTable) {
        let statement = match table {
            MissingTable::State => {
                "ALTER TABLE local_project_index_state RENAME TO damaged_project_index_state"
            }
            MissingTable::Sessions => {
                "ALTER TABLE local_session_projects RENAME TO damaged_session_projects"
            }
        };
        let conn = store::open(db_path).expect("open index");
        conn.execute_batch(statement).expect("hide index table");
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{self, Outcome};
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct TestDb(std::path::PathBuf);

    impl TestDb {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tokenledger_behavior_view_{tag}_{}_{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create test dir");
            let db = dir.join("tokenboard.db");
            crate::db::init_test_db(&db).expect("init test db");
            Self(db)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    fn collecting(db: &TestDb) -> CollectingView {
        match load(db.path()).expect("load view") {
            ProjectIndexView::On(view) => view,
            ProjectIndexView::Off { state } => panic!("expected a collecting view, got {state}"),
        }
    }

    fn off_state(db: &TestDb) -> &'static str {
        match load(db.path()).expect("load view") {
            ProjectIndexView::Off { state } => state,
            ProjectIndexView::On(view) => panic!("expected no project data, got {}", view.state),
        }
    }

    fn project<'v>(view: &'v CollectingView, tool: &str, session: &str) -> &'v ProjectEntry {
        match view.place(tool, session) {
            Some(SessionPlace::Project(index)) => &view.projects[index],
            other => panic!("{tool}/{session} is not a project: {other:?}"),
        }
    }

    #[test]
    fn states_follow_the_status_command_and_hide_rows_when_not_collecting() {
        let db = TestDb::new("states");
        assert_eq!(off_state(&db), "disabled");

        test_support::enable(db.path());
        test_support::store_sessions(db.path(), &[("Codex", "s1", Outcome::Named("Alpha"))]);
        let view = collecting(&db);
        assert_eq!(view.state, "indexing");
        assert_eq!(view.last_failure, None);
        assert_eq!(
            project(&view, "Codex", "s1").label.as_deref(),
            Some("Alpha")
        );

        test_support::mark_ready(db.path());
        assert_eq!(collecting(&db).state, "ready");

        test_support::mark_failed(db.path(), "database_error");
        let failed = collecting(&db);
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.last_failure, Some("database_error"));
        // Stored rows stay visible while failed.
        assert!(failed.place("Codex", "s1").is_some());

        // An older consent pauses collection: the stored rows stay hidden.
        test_support::downgrade_consent(db.path());
        assert_eq!(off_state(&db), "consent_required");

        // A switched-off index never shows rows, even ones left behind.
        test_support::enable(db.path());
        test_support::store_sessions(db.path(), &[("Codex", "s1", Outcome::Named("Alpha"))]);
        test_support::switch_off_keeping_rows(db.path());
        assert_eq!(off_state(&db), "disabled");

        test_support::enable(db.path());
        test_support::disable(db.path());
        assert_eq!(off_state(&db), "disabled");
    }

    #[test]
    fn only_fixed_failure_codes_leave_the_view() {
        let db = TestDb::new("failure_codes");
        test_support::enable(db.path());
        test_support::mark_failed(db.path(), "internal_error");
        assert_eq!(collecting(&db).last_failure, Some("internal_error"));
        // Any other stored value (a later code, or a marker such as
        // `purge_pending`) is dropped instead of being passed through.
        test_support::mark_failed(db.path(), "purge_pending");
        let view = collecting(&db);
        assert_eq!(view.state, "failed");
        assert_eq!(view.last_failure, None);
        // Not failed: no failure code at all.
        test_support::mark_ready(db.path());
        assert_eq!(collecting(&db).last_failure, None);
    }

    #[test]
    fn places_keys_and_display_names() {
        let db = TestDb::new("places");
        test_support::enable(db.path());
        test_support::store_sessions(
            db.path(),
            &[
                ("Codex", "a1", Outcome::Named("Sample-App")),
                ("Codex", "a2", Outcome::Named("Sample-App")),
                ("Claude", "a3", Outcome::Named("sample-app")),
                ("Claude", "b1", Outcome::Named("beta")),
                ("Codex", "b2", Outcome::Named("Beta")),
                ("Codex", "h1", Outcome::Home),
                ("Codex", "r1", Outcome::Root),
                ("Codex", "t1", Outcome::Temp),
                ("Claude", "m1", Outcome::Managed),
                ("Antigravity", "u1", Outcome::UnsupportedSource),
                ("Claude", "x1", Outcome::Unresolved("source_missing")),
                ("Claude", "x2", Outcome::Unresolved("invalid_path")),
                ("Codex", "x3", Outcome::Unresolved("budget_exceeded")),
            ],
        );
        let view = collecting(&db);

        // Spellings that differ only in case share one key; the name most
        // sessions use is shown, a tie falls to code-point order.
        let sample = project(&view, "Claude", "a3");
        assert_eq!(sample.key, "n:sample-app");
        assert_eq!(sample.label.as_deref(), Some("Sample-App"));
        assert_eq!(sample.kind, "named");
        assert_eq!(project(&view, "Codex", "a1"), sample);
        let beta = project(&view, "Codex", "b2");
        assert_eq!(beta.key, "n:beta");
        assert_eq!(beta.label.as_deref(), Some("Beta"));

        for (session, key, kind) in [
            ("h1", "@home", "home"),
            ("r1", "@root", "root"),
            ("t1", "@temp", "temp"),
        ] {
            let group = project(&view, "Codex", session);
            assert_eq!((group.key.as_str(), group.kind), (key, kind));
            assert_eq!(group.label, None);
        }
        assert_eq!(project(&view, "Claude", "m1").key, "@managed");

        assert_eq!(
            view.place("Antigravity", "u1"),
            Some(SessionPlace::UnsupportedSource)
        );
        for (tool, session) in [("Claude", "x1"), ("Claude", "x2"), ("Codex", "x3")] {
            assert_eq!(view.place(tool, session), Some(SessionPlace::Unresolved));
        }
        // No index row: pending, and the tool is part of the session key.
        assert_eq!(view.place("Codex", "never-indexed"), None);
        assert_eq!(view.place("Claude", "a1"), None);
        // Two named projects and four groups; unresolved rows are no entry.
        assert_eq!(view.projects.len(), 6);
        assert!(view
            .projects
            .iter()
            .all(|entry| !entry.key.starts_with("@unresolved")));
    }

    #[test]
    fn named_keys_come_from_the_stored_name_not_the_stored_key() {
        let db = TestDb::new("keys");
        test_support::enable(db.path());
        test_support::store_sessions(
            db.path(),
            &[
                ("Codex", "s1", Outcome::Named("Alpha")),
                ("Claude", "s2", Outcome::Named("alpha")),
                ("Codex", "s3", Outcome::Named("Beta")),
            ],
        );
        // Hash- and path-shaped stored keys (review P3-2) never leave the view.
        test_support::overwrite_stored_key(db.path(), "Codex", "s1", "n:9f86d081884c7d65");
        test_support::overwrite_stored_key(db.path(), "Codex", "s3", "n:c:users");
        let view = collecting(&db);
        let alpha = project(&view, "Codex", "s1");
        assert_eq!(alpha.key, "n:alpha");
        assert_eq!(alpha.label.as_deref(), Some("Alpha"));
        assert_eq!(project(&view, "Claude", "s2"), alpha);
        assert_eq!(project(&view, "Codex", "s3").key, "n:beta");
        let keys: Vec<&str> = view
            .projects
            .iter()
            .map(|entry| entry.key.as_str())
            .collect();
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().all(|key| *key == "n:alpha" || *key == "n:beta"));
    }
}
