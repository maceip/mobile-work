import type { DatabaseSync } from "node:sqlite";
import type {
  ActorRecord, Caps, GetNodeOptions, JournalStorePort, ListActorsOptions,
  ListEventsOptions, ListNodesOptions, NodeKind, NodeRecord, RunEvent,
  RunRecord, RunSettlementRecord, RunStatus, StoredEvent,
} from "@zcode/dynamic-workflow";
import { dec, enc } from "./db.js";

type Row = Record<string, unknown>;
const s = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const n = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));

function runFromRow(r: Row): RunRecord {
  const out: RunRecord = {
    runId: String(r.run_id),
    caps: { maxConcurrency: Number(r.caps_max_concurrency) },
    spentTokens: Number(r.spent_tokens),
    status: String(r.status) as RunStatus,
  };
  const opt: Array<[string, string | undefined]> = [
    ["parentSessionId", s(r.parent_session_id)], ["cwd", s(r.cwd)], ["name", s(r.name)],
    ["toolCallId", s(r.tool_call_id)], ["scriptText", s(r.script_text)],
    ["scriptHash", s(r.script_hash)], ["resumedFrom", s(r.resumed_from)],
    ["stopReason", s(r.stop_reason)], ["supersededBy", s(r.superseded_by)],
  ];
  for (const [k, v] of opt) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  const args = dec<Record<string, unknown>>(r.args_json as string | null);
  if (args !== undefined) out.args = args;
  const failure = dec<RunRecord["failure"]>(r.failure_json as string | null);
  if (failure !== undefined) out.failure = failure;
  if (r.result_json !== null) out.result = JSON.parse(String(r.result_json)) as unknown;
  return out;
}

function actorFromRow(r: Row, withPersona: boolean): ActorRecord {
  const out: ActorRecord = { runId: String(r.run_id), siteId: String(r.site_id), ordinal: Number(r.ordinal) };
  if (s(r.name) !== undefined) out.name = s(r.name);
  if (withPersona) {
    const p = dec<ActorRecord["persona"]>(r.persona_json as string | null);
    if (p !== undefined) out.persona = p;
  }
  if (s(r.session_id) !== undefined) out.sessionId = s(r.session_id);
  if (s(r.resolved_model) !== undefined) out.resolvedModel = s(r.resolved_model);
  return out;
}

function nodeFromRow(r: Row, withResult: boolean): NodeRecord {
  const out: NodeRecord = {
    runId: String(r.run_id), siteId: String(r.site_id), ordinal: Number(r.ordinal),
    kind: String(r.kind) as NodeKind, inputHash: String(r.input_hash),
    status: String(r.status) as NodeRecord["status"],
  };
  if (s(r.actor_site_id) !== undefined) out.actorSiteId = s(r.actor_site_id);
  if (n(r.actor_ordinal) !== undefined) out.actorOrdinal = n(r.actor_ordinal);
  if (n(r.actor_seq) !== undefined) out.actorSeq = n(r.actor_seq);
  if (withResult && r.result_json !== null) out.result = JSON.parse(String(r.result_json)) as unknown;
  const err = dec<NodeRecord["error"]>(r.error_json as string | null);
  if (err !== undefined) out.error = err;
  const stats = dec<NodeRecord["stats"]>(r.stats_json as string | null);
  if (stats !== undefined) out.stats = stats;
  if (s(r.artifact_id) !== undefined) out.artifactId = s(r.artifact_id);
  const input = dec<NodeRecord["input"]>(r.input_json as string | null);
  if (input !== undefined) out.input = input;
  if (n(r.message_boundary) !== undefined) out.messageBoundary = n(r.message_boundary);
  return out;
}

export class SqliteJournalStore implements JournalStorePort {
  constructor(private readonly db: DatabaseSync) {}

  createRun(record: RunRecord): void {
    const now = Date.now();
    try {
      this.db.prepare(`INSERT INTO dwf_run(run_id,parent_session_id,cwd,name,tool_call_id,script_text,script_hash,args_json,resumed_from,caps_max_concurrency,spent_tokens,status,stop_reason,superseded_by,failure_json,result_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.runId, record.parentSessionId ?? null, record.cwd ?? null, record.name ?? null,
        record.toolCallId ?? null, record.scriptText ?? null, record.scriptHash ?? null,
        enc(record.args), record.resumedFrom ?? null, record.caps.maxConcurrency,
        record.spentTokens, record.status, record.stopReason ?? null, record.supersededBy ?? null,
        enc(record.failure), enc(record.result), now, now);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new Error(`journal: run ${record.runId} already exists`);
      throw e;
    }
  }

  getRun(runId: string): RunRecord | undefined {
    const r = this.db.prepare("SELECT * FROM dwf_run WHERE run_id=?").get(runId) as Row | undefined;
    return r === undefined ? undefined : runFromRow(r);
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    this.requireRun(runId);
    const now = Date.now();
    if (status === "pending" || status === "running") {
      this.db.prepare("UPDATE dwf_run SET status=?, failure_json=NULL, result_json=NULL, stop_reason=NULL, superseded_by=NULL, updated_at=? WHERE run_id=?")
        .run(status, now, runId);
      return;
    }
    // Failure triple rewritten wholesale; result only when present (memory semantics).
    if (settlement?.result !== undefined) {
      this.db.prepare("UPDATE dwf_run SET status=?, stop_reason=?, superseded_by=?, failure_json=?, result_json=?, updated_at=? WHERE run_id=?")
        .run(status, settlement?.stopReason ?? null, settlement?.supersededBy ?? null, enc(settlement?.failure), enc(settlement.result), now, runId);
    } else {
      this.db.prepare("UPDATE dwf_run SET status=?, stop_reason=?, superseded_by=?, failure_json=?, updated_at=? WHERE run_id=?")
        .run(status, settlement?.stopReason ?? null, settlement?.supersededBy ?? null, enc(settlement?.failure), now, runId);
    }
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    this.requireRun(runId);
    this.db.prepare("UPDATE dwf_run SET spent_tokens=?, updated_at=? WHERE run_id=?").run(spentTokens, Date.now(), runId);
  }

  updateRunCaps(runId: string, caps: Caps): void {
    this.requireRun(runId);
    this.db.prepare("UPDATE dwf_run SET caps_max_concurrency=?, updated_at=? WHERE run_id=?").run(caps.maxConcurrency, Date.now(), runId);
  }

  updateRunScript(runId: string, scriptText: string, scriptHash: string): void {
    this.requireRun(runId);
    this.db.prepare("UPDATE dwf_run SET script_text=?, script_hash=?, updated_at=? WHERE run_id=?").run(scriptText, scriptHash, Date.now(), runId);
  }

  putActor(record: ActorRecord): void {
    this.requireRun(record.runId);
    this.db.prepare(`INSERT INTO dwf_actor(run_id,site_id,ordinal,name,persona_json,session_id,resolved_model) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(run_id,site_id,ordinal) DO UPDATE SET name=excluded.name, persona_json=excluded.persona_json, session_id=excluded.session_id, resolved_model=excluded.resolved_model`)
      .run(record.runId, record.siteId, record.ordinal, record.name ?? null, enc(record.persona), record.sessionId ?? null, record.resolvedModel ?? null);
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const r = this.db.prepare("SELECT * FROM dwf_actor WHERE run_id=? AND site_id=? AND ordinal=?")
      .get(runId, siteId, ordinal) as Row | undefined;
    return r === undefined ? undefined : actorFromRow(r, true);
  }

  listActors(runId: string, opts: ListActorsOptions): ActorRecord[] {
    const rows = (opts.name === undefined
      ? this.db.prepare("SELECT * FROM dwf_actor WHERE run_id=? ORDER BY rowid").all(runId)
      : this.db.prepare("SELECT * FROM dwf_actor WHERE run_id=? AND name=? ORDER BY rowid").all(runId, opts.name)) as Row[];
    return rows.map((r) => actorFromRow(r, opts.withPersona));
  }

  putNode(record: NodeRecord): void {
    this.requireRun(record.runId);
    this.db.prepare(`INSERT INTO dwf_node(run_id,site_id,ordinal,kind,actor_site_id,actor_ordinal,actor_seq,input_hash,input_json,status,result_json,error_json,stats_json,artifact_id,message_boundary)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id,site_id,ordinal) DO UPDATE SET kind=excluded.kind, actor_site_id=excluded.actor_site_id,
        actor_ordinal=excluded.actor_ordinal, actor_seq=excluded.actor_seq, input_hash=excluded.input_hash,
        input_json=excluded.input_json, status=excluded.status, result_json=excluded.result_json,
        error_json=excluded.error_json, stats_json=excluded.stats_json, artifact_id=excluded.artifact_id,
        message_boundary=excluded.message_boundary`)
      .run(record.runId, record.siteId, record.ordinal, record.kind, record.actorSiteId ?? null,
        record.actorOrdinal ?? null, record.actorSeq ?? null, record.inputHash, enc(record.input),
        record.status, enc(record.result), enc(record.error), enc(record.stats),
        record.artifactId ?? null, record.messageBoundary ?? null);
  }

  getNode(runId: string, siteId: string, ordinal: number, opts?: GetNodeOptions): NodeRecord | undefined {
    const r = this.db.prepare("SELECT * FROM dwf_node WHERE run_id=? AND site_id=? AND ordinal=?")
      .get(runId, siteId, ordinal) as Row | undefined;
    return r === undefined ? undefined : nodeFromRow(r, opts?.withResult ?? true);
  }

  listNodes(runId: string, opts: ListNodesOptions): NodeRecord[] {
    let sql = "SELECT *, length(CAST(result_json AS BLOB)) AS result_bytes FROM dwf_node WHERE run_id=?";
    const params: unknown[] = [runId];
    if (opts.kinds !== "all") {
      if (opts.kinds.length === 0) return [];
      sql += ` AND kind IN (${opts.kinds.map(() => "?").join(",")})`;
      params.push(...opts.kinds);
    }
    sql += " ORDER BY rowid";
    if (opts.limit !== undefined) { sql += " LIMIT ?"; params.push(Math.max(0, opts.limit)); }
    const rows = this.db.prepare(sql).all(...(params as never[])) as Row[];
    let kept = rows;
    if (opts.maxResultBytes !== undefined) {
      kept = [];
      let total = 0;
      for (const r of rows) {
        const bytes = r.result_bytes === null ? 0 : Number(r.result_bytes);
        if (kept.length > 0 && total + bytes > opts.maxResultBytes) break;
        kept.push(r); total += bytes;
      }
    }
    return kept.map((r) => nodeFromRow(r, opts.withResult));
  }

  countNodes(runId: string, kind: NodeKind): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM dwf_node WHERE run_id=? AND kind=?").get(runId, kind) as { c: number };
    return Number(r.c);
  }

  sumResultBytes(runId: string, kind: NodeKind): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))),0) AS b FROM dwf_node WHERE run_id=? AND kind=? AND result_json IS NOT NULL")
      .get(runId, kind) as { b: number };
    return Number(r.b);
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
    this.requireRun(runId);
    const seqRow = this.db.prepare("SELECT COALESCE(MAX(sequence),-1)+1 AS seq FROM dwf_event WHERE run_id=?").get(runId) as { seq: number };
    const sequence = Number(seqRow.seq);
    const timeCreated = Date.now();
    this.db.prepare("INSERT INTO dwf_event(run_id,sequence,type,event_json,time_created) VALUES (?,?,?,?,?)")
      .run(runId, sequence, event.type, JSON.stringify(event), timeCreated);
    return { sequence, event: JSON.parse(JSON.stringify(event)) as RunEvent, timeCreated };
  }

  listEvents(runId: string, opts: ListEventsOptions): StoredEvent[] {
    const run = this.db.prepare("SELECT 1 AS x FROM dwf_run WHERE run_id=?").get(runId);
    if (run === undefined) return [];
    const stripped = new Set<number>();
    if (opts.reportItems !== "all") {
      const rows = this.db.prepare("SELECT sequence FROM dwf_event WHERE run_id=? AND type='report' ORDER BY sequence LIMIT -1 OFFSET ?")
        .all(runId, Math.max(0, opts.reportItems.limit)) as Array<{ sequence: number }>;
      for (const r of rows) stripped.add(Number(r.sequence));
    }
    let sql = "SELECT * FROM dwf_event WHERE run_id=?";
    const params: unknown[] = [runId];
    if (opts.types !== "all") {
      if (opts.types.length === 0) return [];
      sql += ` AND type IN (${opts.types.map(() => "?").join(",")})`;
      params.push(...opts.types);
    }
    if (opts.afterSequence !== undefined) { sql += " AND sequence > ?"; params.push(opts.afterSequence); }
    sql += " ORDER BY sequence";
    if (opts.limit !== undefined) { sql += " LIMIT ?"; params.push(Math.max(0, opts.limit)); }
    const rows = this.db.prepare(sql).all(...(params as never[])) as Row[];
    return rows.map((r) => {
      const event = JSON.parse(String(r.event_json)) as RunEvent & { item?: unknown };
      if (stripped.has(Number(r.sequence))) delete event.item;
      return { sequence: Number(r.sequence), event, timeCreated: Number(r.time_created) };
    });
  }

  private requireRun(runId: string): void {
    const r = this.db.prepare("SELECT 1 AS x FROM dwf_run WHERE run_id=?").get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
  }
}
