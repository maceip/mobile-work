import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 1;

const MIGRATION_1 = `
CREATE TABLE dwf_run (
  run_id TEXT PRIMARY KEY, parent_session_id TEXT, cwd TEXT, name TEXT, tool_call_id TEXT,
  script_text TEXT, script_hash TEXT, args_json TEXT, resumed_from TEXT,
  caps_max_concurrency INTEGER NOT NULL, spent_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, stop_reason TEXT, superseded_by TEXT,
  failure_json TEXT, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE dwf_actor (
  run_id TEXT NOT NULL, site_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  name TEXT, persona_json TEXT, session_id TEXT, resolved_model TEXT,
  PRIMARY KEY (run_id, site_id, ordinal),
  FOREIGN KEY (run_id) REFERENCES dwf_run(run_id)
);
CREATE TABLE dwf_node (
  run_id TEXT NOT NULL, site_id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL,
  actor_site_id TEXT, actor_ordinal INTEGER, actor_seq INTEGER,
  input_hash TEXT NOT NULL, input_json TEXT, status TEXT NOT NULL,
  result_json TEXT, error_json TEXT, stats_json TEXT, artifact_id TEXT, message_boundary INTEGER,
  PRIMARY KEY (run_id, site_id, ordinal),
  UNIQUE (run_id, actor_site_id, actor_ordinal, actor_seq),
  FOREIGN KEY (run_id) REFERENCES dwf_run(run_id)
);
CREATE TABLE dwf_event (
  run_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL,
  event_json TEXT NOT NULL, time_created INTEGER NOT NULL,
  PRIMARY KEY (run_id, sequence),
  FOREIGN KEY (run_id) REFERENCES dwf_run(run_id)
);
CREATE INDEX dwf_event_type ON dwf_event(run_id, type, sequence);
CREATE TABLE zf_workspace (workspace_key TEXT PRIMARY KEY, canonical_path TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE zf_owner (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, owner_id TEXT NOT NULL, pid INTEGER NOT NULL, started_at INTEGER NOT NULL);
CREATE TABLE zf_command (
  command_id TEXT PRIMARY KEY, run_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER
);
CREATE TABLE zf_effect (
  operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, run_revision TEXT NOT NULL,
  site_id TEXT NOT NULL, ordinal INTEGER NOT NULL, tool_ordinal INTEGER NOT NULL,
  tool_name TEXT NOT NULL, input_json TEXT NOT NULL, input_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, cwd TEXT NOT NULL,
  authorization_json TEXT, result_json TEXT, artifact_ref TEXT,
  pre_hash TEXT, post_hash TEXT, pid INTEGER,
  created_at INTEGER NOT NULL, dispatched_at INTEGER, settled_at INTEGER
);
CREATE INDEX zf_effect_run ON zf_effect(run_id, state);
CREATE TABLE zf_question (
  question_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, operation_id TEXT,
  payload_json TEXT NOT NULL, policy_digest TEXT NOT NULL, status TEXT NOT NULL,
  answer_json TEXT, created_at INTEGER NOT NULL, answered_at INTEGER
);
CREATE TABLE zf_session (
  session_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, run_id TEXT, title TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE zf_message (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
  content_json TEXT NOT NULL, step_id TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE zf_artifact (
  artifact_id TEXT PRIMARY KEY, run_id TEXT, kind TEXT NOT NULL, rel_path TEXT NOT NULL,
  bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, content_type TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE zf_episode (
  episode_id TEXT PRIMARY KEY, run_id TEXT, task_json TEXT, gates_json TEXT NOT NULL,
  gates_digest TEXT NOT NULL, limits_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
);
`;

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations").get() as { v: number };
  if (row.v < 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATION_1);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(Date.now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (row.v > SCHEMA_VERSION) throw new Error(`database schema v${row.v} is newer than supported v${SCHEMA_VERSION}`);
  return db;
}

const txDepth = new WeakMap<DatabaseSync, number>();

/** Re-entrant transaction helper: nested calls use savepoints. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth === 0) db.exec("BEGIN IMMEDIATE"); else db.exec(`SAVEPOINT zf_tx_${depth}`);
  txDepth.set(db, depth + 1);
  try {
    const out = fn();
    txDepth.set(db, depth);
    if (depth === 0) db.exec("COMMIT"); else db.exec(`RELEASE SAVEPOINT zf_tx_${depth}`);
    return out;
  } catch (e) {
    txDepth.set(db, depth);
    if (depth === 0) db.exec("ROLLBACK");
    else { db.exec(`ROLLBACK TO SAVEPOINT zf_tx_${depth}`); db.exec(`RELEASE SAVEPOINT zf_tx_${depth}`); }
    throw e;
  }
}

export const enc = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
export const dec = <T>(v: string | null): T | undefined => (v === null ? undefined : (JSON.parse(v) as T));
