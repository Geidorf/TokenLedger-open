-- Subset of goose's sessions.db schema with sample rows (no real paths or names).
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    working_dir TEXT NOT NULL,
    accumulated_input_tokens INTEGER,
    accumulated_output_tokens INTEGER,
    provider_name TEXT
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL
);
CREATE TABLE usage_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_timestamp INTEGER NOT NULL,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    cost REAL,
    cost_source TEXT,
    is_compaction INTEGER DEFAULT 0
);
INSERT INTO sessions VALUES ('20261021_1', 'fix tests', '/work/demo', 34100, 760, 'databricks');
INSERT INTO messages (session_id, role, content_json) VALUES ('20261021_1', 'user', '[{"type":"text","text":"fix tests"}]');
INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction) VALUES
    ('20261021_1', 1792573200, 'databricks/claude-sonnet-4.6', 30000, 700, 30700, 25000, 1000, 0.021, 'provider_reported', 0),
    ('20261021_1', 1792573260, 'gpt-5.4', 4000, 50, 4050, 0, 0, 0.003, 'estimated', 1),
    ('20261021_1', 1792573320, NULL, 100, 10, 110, NULL, NULL, NULL, NULL, 0),
    ('20261021_1', 1792573380, 'gpt-5.4', 0, 0, 0, 0, 0, NULL, NULL, 0),
    ('20261021_1', 1792573440, 'gpt-5.4', -5, 10, 5, 0, 0, NULL, NULL, 0);
