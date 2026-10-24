import type { DatabaseSync } from "node:sqlite";
import type { EffectIntent, EffectRecord, EffectState } from "@zfacade/contracts";
import { digestOf, newId, operationKey, READONLY_TOOLS, ZfacadeError } from "@zfacade/contracts";
import { tx } from "./db.js";
import { EffectRepo } from "./repos.js";

const TERMINAL: ReadonlySet<EffectState> = new Set(["completed", "failed", "denied", "outcome_unknown", "cancelled"]);

/** Test-only crash seams. Production composition passes no hooks. */
export interface EffectHooks {
  afterDispatch?: (rec: EffectRecord) => void;
  afterEffect?: (rec: EffectRecord) => void;
}

export class EffectService {
  readonly repo: EffectRepo;
  constructor(private readonly db: DatabaseSync, private readonly hooks: EffectHooks = {}) {
    this.repo = new EffectRepo(db);
  }

  keyFor(intent: EffectIntent): { key: string; inputDigest: string } {
    const inputDigest = digestOf({ tool: intent.toolName, input: intent.input, cwd: intent.cwd });
    return {
      inputDigest,
      key: operationKey({
        runRevision: intent.runRevision, siteId: intent.siteId,
        ordinal: intent.ordinal, toolOrdinal: intent.toolOrdinal, inputDigest,
      }),
    };
  }

  /** Idempotent admission: same key returns the existing receipt row. */
  admit(intent: EffectIntent): EffectRecord {
    return tx(this.db, () => {
      const { key, inputDigest } = this.keyFor(intent);
      const existing = this.repo.getByKey(key);
      if (existing) return existing;
      const rec: EffectRecord = {
        ...intent, operationId: newId("op"), inputDigest, idempotencyKey: key,
        state: "intended", createdAt: Date.now(),
      };
      this.repo.insert(rec);
      return rec;
    });
  }

  authorize(operationId: string, authorization: unknown): EffectRecord {
    return this.mutate(operationId, (rec) => {
      if (rec.state !== "intended") throw new ZfacadeError("EffectConflict", `cannot authorize effect in state ${rec.state}`);
      rec.state = "authorized"; rec.authorization = authorization;
    });
  }

  deny(operationId: string, reason: string): EffectRecord {
    return this.mutate(operationId, (rec) => {
      if (TERMINAL.has(rec.state)) throw new ZfacadeError("EffectConflict", `effect already terminal: ${rec.state}`);
      rec.state = "denied"; rec.result = { error: reason }; rec.settledAt = Date.now();
    });
  }

  markDispatched(operationId: string, pid?: number): EffectRecord {
    const rec = this.mutate(operationId, (r) => {
      if (r.state !== "authorized") throw new ZfacadeError("EffectConflict", `cannot dispatch effect in state ${r.state}`);
      r.state = "dispatched"; r.dispatchedAt = Date.now();
      if (pid !== undefined) r.pid = pid;
    });
    this.hooks.afterDispatch?.(rec);
    return rec;
  }

  noteEffectPerformed(operationId: string): void {
    const rec = this.repo.get(operationId);
    if (rec) this.hooks.afterEffect?.(rec);
  }

  settleCompleted(operationId: string, result: unknown, extra?: { artifactRef?: string; preHash?: string; postHash?: string }): EffectRecord {
    return this.mutate(operationId, (rec) => {
      if (TERMINAL.has(rec.state)) throw new ZfacadeError("EffectConflict", `duplicate settlement for completed effect in state ${rec.state} (first receipt wins)`);
      rec.state = "completed"; rec.result = result; rec.settledAt = Date.now();
      if (extra?.artifactRef !== undefined) rec.artifactRef = extra.artifactRef;
      if (extra?.preHash !== undefined) rec.preHash = extra.preHash;
      if (extra?.postHash !== undefined) rec.postHash = extra.postHash;
    });
  }

  settleFailed(operationId: string, error: string): EffectRecord {
    return this.mutate(operationId, (rec) => {
      if (TERMINAL.has(rec.state)) throw new ZfacadeError("EffectConflict", `duplicate settlement in state ${rec.state}`);
      rec.state = "failed"; rec.result = { error }; rec.settledAt = Date.now();
    });
  }

  /** Readonly dispatched effects may be retried as the same operation (new attempt recorded in result history). */
  prepareRetry(rec: EffectRecord): EffectRecord {
    if (!(READONLY_TOOLS.has(rec.toolName as never) || rec.toolName.startsWith("world-read"))) return rec;
    if (rec.state !== "dispatched" && rec.state !== "started") return rec;
    return this.mutate(rec.operationId, (r) => { r.state = "authorized"; });
  }

  /**
   * Startup recovery scan (plan 5.3): dispatched/started mutating effects with
   * no terminal receipt become outcome_unknown holds. Returns the held rows.
   */
  recoverScan(): EffectRecord[] {
    return tx(this.db, () => {
      const held: EffectRecord[] = [];
      for (const rec of this.repo.listByState(["dispatched", "started"])) {
        if (READONLY_TOOLS.has(rec.toolName as never) || rec.toolName.startsWith("world-read")) continue;
        rec.state = "outcome_unknown";
        rec.result = { error: "dispatched before interruption; outcome unknown", recoveredAt: Date.now() };
        rec.settledAt = Date.now();
        this.repo.update(rec);
        held.push(rec);
      }
      return held;
    });
  }

  holds(): EffectRecord[] {
    return this.repo.listByState(["outcome_unknown"]);
  }

  reconcile(operationId: string, decision: "mark-completed" | "retry" | "abandon", evidence?: unknown): EffectRecord {
    return this.mutate(operationId, (rec) => {
      if (rec.state !== "outcome_unknown") throw new ZfacadeError("EffectConflict", `reconcile requires outcome_unknown, got ${rec.state}`);
      if (decision === "mark-completed") {
        rec.state = "completed";
        rec.result = { reconciled: "mark-completed", evidence: evidence ?? null, previous: rec.result ?? null };
      } else if (decision === "retry") {
        rec.state = "authorized";
        rec.result = { reconciled: "retry", evidence: evidence ?? null };
        delete rec.settledAt; delete rec.dispatchedAt;
      } else {
        rec.state = "cancelled";
        rec.result = { reconciled: "abandon", evidence: evidence ?? null };
      }
      rec.settledAt = decision === "retry" ? undefined : Date.now();
    });
  }

  private mutate(operationId: string, fn: (rec: EffectRecord) => void): EffectRecord {
    return tx(this.db, () => {
      const rec = this.repo.get(operationId);
      if (!rec) throw new ZfacadeError("EffectNotFound", `unknown effect ${operationId}`);
      fn(rec);
      this.repo.update(rec);
      return rec;
    });
  }
}
