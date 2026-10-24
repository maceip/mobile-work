import type { DatabaseSync } from "node:sqlite";
import type { EffectRecord, EffectState, QuestionRecord } from "@zfacade/contracts";
import { dec, enc } from "./db.js";

type Row = Record<string, unknown>;

export function effectFromRow(r: Row): EffectRecord {
  const out: EffectRecord = {
    operationId: String(r.operation_id), runId: String(r.run_id), runRevision: String(r.run_revision),
    siteId: String(r.site_id), ordinal: Number(r.ordinal), toolOrdinal: Number(r.tool_ordinal),
    toolName: String(r.tool_name), input: JSON.parse(String(r.input_json)) as unknown,
    inputDigest: String(r.input_digest), idempotencyKey: String(r.idempotency_key),
    state: String(r.state) as EffectState, cwd: String(r.cwd), createdAt: Number(r.created_at),
  };
  const auth = dec(r.authorization_json as string | null); if (auth !== undefined) out.authorization = auth;
  if (r.result_json !== null) out.result = JSON.parse(String(r.result_json)) as unknown;
  if (r.artifact_ref !== null) out.artifactRef = String(r.artifact_ref);
  if (r.pre_hash !== null) out.preHash = String(r.pre_hash);
  if (r.post_hash !== null) out.postHash = String(r.post_hash);
  if (r.pid !== null) out.pid = Number(r.pid);
  if (r.dispatched_at !== null) out.dispatchedAt = Number(r.dispatched_at);
  if (r.settled_at !== null) out.settledAt = Number(r.settled_at);
  return out;
}

export class EffectRepo {
  constructor(private readonly db: DatabaseSync) {}
  insert(rec: EffectRecord): void {
    this.db.prepare(`INSERT INTO zf_effect(operation_id,run_id,run_revision,site_id,ordinal,tool_ordinal,tool_name,input_json,input_digest,idempotency_key,state,cwd,authorization_json,result_json,artifact_ref,pre_hash,post_hash,pid,created_at,dispatched_at,settled_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      rec.operationId, rec.runId, rec.runRevision, rec.siteId, rec.ordinal, rec.toolOrdinal, rec.toolName,
      JSON.stringify(rec.input), rec.inputDigest, rec.idempotencyKey, rec.state, rec.cwd,
      enc(rec.authorization), enc(rec.result), rec.artifactRef ?? null, rec.preHash ?? null,
      rec.postHash ?? null, rec.pid ?? null, rec.createdAt, rec.dispatchedAt ?? null, rec.settledAt ?? null);
  }
  get(operationId: string): EffectRecord | undefined {
    const r = this.db.prepare("SELECT * FROM zf_effect WHERE operation_id=?").get(operationId) as Row | undefined;
    return r === undefined ? undefined : effectFromRow(r);
  }
  getByKey(key: string): EffectRecord | undefined {
    const r = this.db.prepare("SELECT * FROM zf_effect WHERE idempotency_key=?").get(key) as Row | undefined;
    return r === undefined ? undefined : effectFromRow(r);
  }
  update(rec: EffectRecord): void {
    this.db.prepare(`UPDATE zf_effect SET state=?, authorization_json=?, result_json=?, artifact_ref=?, pre_hash=?, post_hash=?, pid=?, dispatched_at=?, settled_at=? WHERE operation_id=?`)
      .run(rec.state, enc(rec.authorization), enc(rec.result), rec.artifactRef ?? null, rec.preHash ?? null,
        rec.postHash ?? null, rec.pid ?? null, rec.dispatchedAt ?? null, rec.settledAt ?? null, rec.operationId);
  }
  listByRun(runId: string): EffectRecord[] {
    return (this.db.prepare("SELECT * FROM zf_effect WHERE run_id=? ORDER BY created_at, rowid").all(runId) as Row[]).map(effectFromRow);
  }
  listByState(states: EffectState[]): EffectRecord[] {
    if (states.length === 0) return [];
    const sql = `SELECT * FROM zf_effect WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at, rowid`;
    return (this.db.prepare(sql).all(...(states as never[])) as Row[]).map(effectFromRow);
  }
}

export class QuestionRepo {
  constructor(private readonly db: DatabaseSync) {}
  insert(q: QuestionRecord): void {
    this.db.prepare("INSERT INTO zf_question(question_id,run_id,kind,operation_id,payload_json,policy_digest,status,answer_json,created_at,answered_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(q.questionId, q.runId, q.kind, q.operationId ?? null, JSON.stringify(q.payload), q.policyDigest, q.status, enc(q.answer), q.createdAt, q.answeredAt ?? null);
  }
  get(questionId: string): QuestionRecord | undefined {
    const r = this.db.prepare("SELECT * FROM zf_question WHERE question_id=?").get(questionId) as Row | undefined;
    if (r === undefined) return undefined;
    const out: QuestionRecord = {
      questionId: String(r.question_id), runId: String(r.run_id), kind: String(r.kind) as QuestionRecord["kind"],
      payload: JSON.parse(String(r.payload_json)) as unknown, policyDigest: String(r.policy_digest),
      status: String(r.status) as QuestionRecord["status"], createdAt: Number(r.created_at),
    };
    if (r.operation_id !== null) out.operationId = String(r.operation_id);
    const a = dec(r.answer_json as string | null); if (a !== undefined) out.answer = a;
    if (r.answered_at !== null) out.answeredAt = Number(r.answered_at);
    return out;
  }
  update(q: QuestionRecord): void {
    this.db.prepare("UPDATE zf_question SET status=?, answer_json=?, answered_at=? WHERE question_id=?")
      .run(q.status, enc(q.answer), q.answeredAt ?? null, q.questionId);
  }
  pendingByRun(runId: string): QuestionRecord[] {
    return (this.db.prepare("SELECT question_id FROM zf_question WHERE run_id=? AND status='pending' ORDER BY created_at").all(runId) as Array<{ question_id: string }>)
      .map((r) => this.get(String(r.question_id))!);
  }
}

export interface CommandRecord { commandId: string; runId?: string; kind: string; payload: unknown; status: string; createdAt: number; settledAt?: number }

export class CommandRepo {
  constructor(private readonly db: DatabaseSync) {}
  insert(c: CommandRecord): void {
    this.db.prepare("INSERT INTO zf_command(command_id,run_id,kind,payload_json,status,created_at,settled_at) VALUES (?,?,?,?,?,?,?)")
      .run(c.commandId, c.runId ?? null, c.kind, JSON.stringify(c.payload), c.status, c.createdAt, c.settledAt ?? null);
  }
  setStatus(commandId: string, status: string): void {
    this.db.prepare("UPDATE zf_command SET status=?, settled_at=? WHERE command_id=?").run(status, Date.now(), commandId);
  }
  pending(): CommandRecord[] {
    return (this.db.prepare("SELECT * FROM zf_command WHERE status IN ('pending','admitted') ORDER BY created_at, rowid").all() as Row[]).map((r) => ({
      commandId: String(r.command_id), runId: r.run_id === null ? undefined : String(r.run_id),
      kind: String(r.kind), payload: JSON.parse(String(r.payload_json)) as unknown,
      status: String(r.status), createdAt: Number(r.created_at),
    }));
  }
}

export interface SessionRow { sessionId: string; workspaceKey: string; runId?: string; title?: string; createdAt: number; updatedAt: number }

export class SessionRepo {
  constructor(private readonly db: DatabaseSync) {}
  insert(s: SessionRow): void {
    this.db.prepare("INSERT INTO zf_session(session_id,workspace_key,run_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(s.sessionId, s.workspaceKey, s.runId ?? null, s.title ?? null, s.createdAt, s.updatedAt);
  }
  appendMessage(sessionId: string, role: string, content: unknown, stepId?: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq),-1)+1 AS seq FROM zf_message WHERE session_id=?").get(sessionId) as { seq: number };
    const seq = Number(r.seq);
    this.db.prepare("INSERT INTO zf_message(session_id,seq,role,content_json,step_id,created_at) VALUES (?,?,?,?,?,?)")
      .run(sessionId, seq, role, JSON.stringify(content), stepId ?? null, Date.now());
    this.db.prepare("UPDATE zf_session SET updated_at=? WHERE session_id=?").run(Date.now(), sessionId);
    return seq;
  }
  messages(sessionId: string): Array<{ seq: number; role: string; content: unknown; stepId?: string }> {
    return (this.db.prepare("SELECT * FROM zf_message WHERE session_id=? ORDER BY seq").all(sessionId) as Row[]).map((r) => ({
      seq: Number(r.seq), role: String(r.role), content: JSON.parse(String(r.content_json)) as unknown,
      stepId: r.step_id === null ? undefined : String(r.step_id),
    }));
  }
  list(): SessionRow[] {
    return (this.db.prepare("SELECT * FROM zf_session ORDER BY updated_at DESC").all() as Row[]).map((r) => ({
      sessionId: String(r.session_id), workspaceKey: String(r.workspace_key),
      runId: r.run_id === null ? undefined : String(r.run_id),
      title: r.title === null ? undefined : String(r.title),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    }));
  }
}

export interface EpisodeRow { episodeId: string; runId?: string; task?: unknown; gates: unknown; gatesDigest: string; limits: unknown; status: string; createdAt: number }

export class EpisodeRepo {
  constructor(private readonly db: DatabaseSync) {}
  insert(e: EpisodeRow): void {
    this.db.prepare("INSERT INTO zf_episode(episode_id,run_id,task_json,gates_json,gates_digest,limits_json,status,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(e.episodeId, e.runId ?? null, enc(e.task), JSON.stringify(e.gates), e.gatesDigest, JSON.stringify(e.limits), e.status, e.createdAt);
  }
  setRun(episodeId: string, runId: string): void {
    this.db.prepare("UPDATE zf_episode SET run_id=? WHERE episode_id=?").run(runId, episodeId);
  }
  setStatus(episodeId: string, status: string): void {
    this.db.prepare("UPDATE zf_episode SET status=? WHERE episode_id=?").run(status, episodeId);
  }
}

export class ArtifactRepo {
  constructor(private readonly db: DatabaseSync) {}
  insert(a: { artifactId: string; runId?: string; kind: string; relPath: string; bytes: number; sha256: string; contentType?: string }): void {
    this.db.prepare("INSERT INTO zf_artifact(artifact_id,run_id,kind,rel_path,bytes,sha256,content_type,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(a.artifactId, a.runId ?? null, a.kind, a.relPath, a.bytes, a.sha256, a.contentType ?? null, Date.now());
  }
  totalBytes(): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM zf_artifact").get() as { b: number };
    return Number(r.b);
  }
}
