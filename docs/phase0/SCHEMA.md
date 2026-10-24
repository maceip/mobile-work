# Phase 0 storage schema and transaction boundaries

One SQLite database per workspace: `~/.zfacade/workspaces/<workspaceKey>/zfacade.sqlite`.
`workspaceKey` = lowercase hex SHA-256 of the canonical (realpath) workspace
directory, persisted with the workspace path in `~/.zfacade/workspaces/index.json`
(paths only, no credentials). Artifacts (full tool outputs, published bytes) live
in `~/.zfacade/workspaces/<workspaceKey>/artifacts/`; the database stores
references + hashes, never large bytes.

Pragmas: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`,
`busy_timeout=5000`. Migrations are versioned (`schema_migrations`), applied in
one transaction each. Current version: 1.

## Tables (v1)

Journal (mirrors upstream `JournalStorePort` record shapes; fresh zfacade schema):

- `dwf_run(run_id PK, parent_session_id, cwd, name, tool_call_id, script_text, script_hash, args_json, resumed_from, caps_max_concurrency, spent_tokens, status, stop_reason, superseded_by, failure_json, result_json, created_at, updated_at)`
- `dwf_actor(run_id, site_id, ordinal, name, persona_json, session_id, resolved_model, PK(run_id,site_id,ordinal))`
- `dwf_node(run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq, input_hash, input_json, status, result_json, error_json, stats_json, artifact_id, message_boundary, PK(run_id,site_id,ordinal), UNIQUE(run_id,actor_site_id,actor_ordinal,actor_seq))`
- `dwf_event(run_id, sequence, type, event_json, time_created, PK(run_id,sequence))`

zfacade authority tables (same database, same transaction service):

- `zf_workspace(workspace_key PK, canonical_path, created_at)`
- `zf_owner(id=1 PK, generation, owner_id, pid, started_at)` — fenced writer generation; OS lock file `coordinator.lock` beside the database is the exclusion mechanism, generation fences stale completions.
- `zf_command(command_id PK, run_id, kind, payload_json, status, created_at, settled_at)` — durable FIFO admission (`pending|admitted|settled|rejected`).
- `zf_effect(operation_id PK, run_id, run_revision, site_id, ordinal, tool_name, input_digest, idempotency_key UNIQUE, state, authorization_json, intent_json, result_json, artifact_ref, pre_hash, post_hash, pid, pid_start, created_at, dispatched_at, settled_at)` — states: `intended|authorized|dispatched|started|completed|failed|denied|outcome_unknown|cancelled`. First terminal receipt wins.
- `zf_question(question_id PK, run_id, kind[clarification|permission], operation_id, payload_json, policy_digest, status[pending|answered|denied|expired], answer_json, created_at, answered_at)`
- `zf_session(session_id PK, workspace_key, run_id, title, created_at, updated_at)` and `zf_message(session_id, seq, role, content_json, step_id, created_at, PK(session_id,seq))` — CLI transcript/context revisions for bounded steps.
- `zf_artifact(artifact_id PK, run_id, kind, rel_path, bytes, sha256, content_type, created_at)`
- `zf_episode(episode_id PK, run_id, task_json, gates_json, gates_digest, limits_json, status, created_at)` — bridge episodes; gate argv + protected files pinned at `open`.

## Transaction boundaries (plan §5.2)

1. Admission: command row + run/step intent commit before acknowledgement.
2. Model response: complete response + ordered tool intents (`zf_effect` intended rows) + step settlement commit together before any tool runs. Partial streams persist only an interruption marker on the session message; partial tool JSON never becomes an intent.
3. Tool dispatch: validated intent + authorization commit (`authorized`), then `dispatched` timestamp before process/file effect. Crash between dispatch and start remains ambiguous by design.
4. Tool settlement: effect terminal receipt + transcript result + node settlement reference commit together. Conflicting duplicate settlement raises.
5. Question answer: answer + consumption commit before dependent work resumes. Duplicate answer is idempotent read; stale/wrong-run answer rejected.
6. Compaction: deferred to Phase 2; schema reserves context revision on `zf_session` (`context_revision` added by later migration, not faked in v1).

Recovery (plan §5.3): `intended/authorized` (never dispatched) may re-dispatch
same operation identity after re-authorization; `completed` replays receipt;
pure reads may retry as new attempt; file mutations settle from pre/post hash
evidence or hold; `dispatched/started` shell/git effects without terminal
receipt become `outcome_unknown` holds blocking dependents until explicit
`recover reconcile` decision (`mark-completed` with evidence | `retry` | `abandon`).
Vendored engine adaptation E2a applies the same rule to `world-run` journal nodes.

Exit codes (headless): `0` completed, `2` pending human input (durable question),
`3` recovery hold, `4` denied, `5` infrastructure/usage error. Documented in CLI help.
