import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  checkSiteStability, collectPhaseNames, lowerWorkflowScript, spliceHoleBody,
  type ImportedRunCache, type RunSettlement,
} from "@zcode/dynamic-workflow";
import type {
  BridgeDiagnostic, BridgeReply, BridgeRequest, EpisodeLimits, EpisodeReceipt, GateSpec, WorkerRequest,
} from "@zfacade/contracts";
import {
  BRIDGE_MAX_BYTES, FACADE_VERSION, REQUIRED_CAPABILITIES, digestOf, invalidatedNodes,
  isTerminalSuccess, newId, replayKey, sha256Hex,
} from "@zfacade/contracts";
import type { PermissionContext, WorkspaceStore } from "@zfacade/core";
import { openWorkspaceStore, resolveInside } from "@zfacade/core";
import {
  BoundedDriver, EngineControl, checkContract, createEpisodeSandbox, destroySandbox, executeRun, fileImports, prepareWorkflow, runArgv, sigTargets,
  spliceBody, typecheckFile, type ParkedAsk, type PreparedWorkflow, type SandboxSpec,
} from "@zfacade/agent";
import { auditTraining, transformTraining } from "./bridge-transform.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bounded = <T,>(items: T[], max = 40): T[] => items.slice(0, max);

/** R7: every diagnostic crossing the bridge is structured and bounded. */
export function toDiagnostic(value: unknown): BridgeDiagnostic {
  if (typeof value === "string") return { code: "note", message: value.slice(0, 1000) };
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const message = typeof o.message === "string" ? o.message : JSON.stringify(value).slice(0, 1000);
    return {
      code: String(o.code ?? "diagnostic"),
      message: message.slice(0, 1000),
      ...(typeof o.line === "number" ? { line: o.line } : {}),
      ...(typeof o.column === "number" ? { column: o.column } : {}),
      ...(typeof o.file === "string" ? { file: o.file } : {}),
    };
  }
  return { code: "diagnostic", message: String(value).slice(0, 1000) };
}
const toDiagnostics = (items: unknown[]): BridgeDiagnostic[] => bounded(items.map(toDiagnostic));

interface Target {
  targetId: string; file: string; symbol: string; bodyHash: string; signature: string;
  signatureSource: string;
  parameters: Array<{ name: string; type: string; optional?: boolean; rest?: boolean }>;
  bodyText: string;
}

interface PendingWorker {
  requestId: string;
  kind: "code" | "data" | "subgraph" | "hole";
  instanceKey?: string;
  holeSiteId?: string;
  targets: Target[];
  obligations: string[];
  rootDigest: string;
  depth: number;
  remainingTargets: Target[];
  request: WorkerRequest;
  typeText?: string;
  typeDefs?: string;
}

interface ActiveRun {
  runId: string;
  driver: BoundedDriver;
  control: EngineControl;
  prepared: PreparedWorkflow;
  scriptText: string;
  originalSource: string;
  abort: AbortController;
  settlement?: RunSettlement;
  promise: Promise<RunSettlement>;
}

export class BridgeServer {
  private store: WorkspaceStore | undefined;
  private sandbox: SandboxSpec | undefined;
  private workspace = "";
  private episodeId = "";
  private task: { task_id?: string; user_prompt?: string; target_files?: string[] } = {};
  private gates: Record<string, GateSpec> = {};
  private gatesDigest = "";
  private limits: EpisodeLimits = { maxWorkerCalls: 8, maxGraphNodes: 64, maxSubgraphExpansions: 32, toolTimeoutSeconds: 60 };
  private protectedBefore = new Map<string, string>();
  private revision = 0;
  private active: ActiveRun | undefined;
  private readonly pending = new Map<string, PendingWorker>();
  private workerCalls = 0;
  private failedAttempts = 0;
  private maxDepth = 1;
  private invalidatedCount = 0;
  private policyViolation = false;
  private readonly diagnostics: BridgeDiagnostic[] = [];
  private readonly sourceCache = new Map<string, string>();
  /** Latest body hash per target applied by this host in the episode (lineage). */
  private readonly appliedBodyHashes = new Map<string, string>();
  private startedAt = Date.now();
  private closed = false;

  async handleLine(line: string): Promise<string | undefined> {
    if (line.length > BRIDGE_MAX_BYTES) return JSON.stringify({ protocol: 1, id: 0, error: { code: "request_too_large", message: "bridge request exceeds 1 MB" } });
    let req: BridgeRequest;
    try { req = JSON.parse(line) as BridgeRequest; }
    catch { return JSON.stringify({ protocol: 1, id: 0, error: { code: "bad_json", message: "request is not valid JSON" } }); }
    const reply = await this.dispatch(req);
    const text = JSON.stringify(reply);
    return text.length > BRIDGE_MAX_BYTES
      ? JSON.stringify({ protocol: 1, id: req.id, error: { code: "reply_too_large", message: "bridge reply exceeds 1 MB" } })
      : text;
  }

  private async dispatch(req: BridgeRequest): Promise<BridgeReply> {
    const ok = (result: Record<string, unknown>): BridgeReply => ({ protocol: 1, id: req.id, result });
    const err = (code: string, message: string): BridgeReply => ({ protocol: 1, id: req.id, error: { code, message } });
    try {
      if (req.protocol !== 1) return err("protocol_mismatch", "expected protocol 1");
      switch (req.method) {
        case "hello": return ok(this.hello());
        case "open": return ok(this.open(req.params));
        case "submit_workflow": return ok(await this.submit(req.params, false));
        case "amend_workflow": return ok(await this.amend(req.params));
        case "resolve_worker": return ok(await this.resolveWorker(req.params));
        case "cancel": return ok(await this.cancel(req.params));
        case "close": return ok(await this.close());
        default: return err("unknown_method", `unknown bridge method: ${req.method}`);
      }
    } catch (e) {
      if ((e as { zfacadeInfra?: boolean }).zfacadeInfra) return err("infrastructure_error", e instanceof Error ? e.message : String(e));
      // Unexpected host failures are infrastructure errors, never zero-reward samples.
      return err("infrastructure_error", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }

  private hello(): Record<string, unknown> {
    return {
      protocol: 1,
      facade_version: FACADE_VERSION,
      runtime: "zfacade-bridge/1",
      capabilities: [...REQUIRED_CAPABILITIES],
      notes: "Subgraph expansion is NOT supported in this pilot (fail-closed diagnostic; sequence separate asks instead). Bridge processes run under a macOS seatbelt profile (write-confined to the episode workspace, network denied, credential reads denied); full OS isolation (A14) remains open.",
    };
  }

  private open(params: Record<string, unknown>): Record<string, unknown> {
    const workspace = String(params.workspace ?? "");
    if (!workspace || !existsSync(workspace) || !statSync(workspace).isDirectory()) {
      throw Object.assign(new Error(`episode workspace does not exist: ${workspace}`), { zfacadeInfra: true });
    }
    this.workspace = workspace;
    this.task = (params.task ?? {}) as typeof this.task;
    const rawGates = (params.gates ?? {}) as Record<string, { argv?: unknown; typecheck_argv?: unknown; protected_files?: unknown }>;
    this.gates = {};
    for (const [id, g] of Object.entries(rawGates)) {
      const argv = g.argv; const tc = g.typecheck_argv; const pf = g.protected_files;
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every((x) => typeof x === "string")) {
        throw Object.assign(new Error(`gate ${id} has no valid argv`), { zfacadeInfra: true });
      }
      this.gates[id] = {
        argv: argv as string[],
        typecheckArgv: Array.isArray(tc) ? (tc as string[]) : [],
        protectedFiles: Array.isArray(pf) ? (pf as string[]) : [],
      };
    }
    const rawLimits = (params.limits ?? {}) as Record<string, unknown>;
    this.limits = {
      maxWorkerCalls: Number(rawLimits.max_worker_calls ?? this.limits.maxWorkerCalls),
      maxGraphNodes: Number(rawLimits.max_graph_nodes ?? this.limits.maxGraphNodes),
      maxSubgraphExpansions: Number(rawLimits.max_subgraph_expansions ?? this.limits.maxSubgraphExpansions),
      toolTimeoutSeconds: Number(rawLimits.tool_timeout_seconds ?? this.limits.toolTimeoutSeconds),
    };
    try { this.store?.release(); } catch { /* prior episode store already released */ }
    // R2 fail-closed: no episode without an enforced sandbox boundary.
    if (this.sandbox) destroySandbox(this.sandbox);
    try {
      this.sandbox = createEpisodeSandbox(workspace);
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { zfacadeInfra: true });
    }
    this.store = openWorkspaceStore(workspace);
    this.store.effects.recoverScan();
    this.protectedBefore = new Map();
    for (const gate of Object.values(this.gates)) {
      for (const rel of gate.protectedFiles) {
        const abs = resolveInside(workspace, rel);
        this.protectedBefore.set(rel, existsSync(abs) ? sha256Hex(readFileSync(abs)) : "<absent>");
      }
    }
    this.gatesDigest = digestOf(this.gates);
    this.episodeId = newId("ep");
    this.revision = 0;
    this.startedAt = Date.now();
    this.store.episodes.insert({
      episodeId: this.episodeId, task: this.task, gates: this.gates,
      gatesDigest: this.gatesDigest, limits: this.limits, status: "open", createdAt: Date.now(),
    });
    return { episode_id: this.episodeId, revision: this.revision, gates_digest: this.gatesDigest, workspace };
  }

  private permission(): PermissionContext {
    return {
      workspaceRoot: this.workspace, cwd: this.workspace, grants: [],
      writeAllowlist: this.task.target_files ?? [],
      protectedFiles: [...this.protectedBefore.keys()],
      pinnedArgv: Object.values(this.gates).flatMap((g) => [g.argv, ...(g.typecheckArgv.length ? [g.typecheckArgv] : [])]),
    };
  }

  private gateMap(): Record<string, { argv: string[]; typecheckArgv?: string[] }> {
    const out: Record<string, { argv: string[]; typecheckArgv?: string[] }> = {};
    for (const [id, g] of Object.entries(this.gates)) out[id] = { argv: g.argv, typecheckArgv: g.typecheckArgv };
    return out;
  }

  private async submit(params: Record<string, unknown>, isAmend: boolean, cache?: ImportedRunCache, resumedFrom?: string): Promise<Record<string, unknown>> {
    if (!this.store) throw Object.assign(new Error("episode not open"), { zfacadeInfra: true });
    const source = String(isAmend ? (params.updated_ts_code ?? "") : (params.ts_code ?? ""));
    if (!source) return this.observation("compile_error", [{ code: "EMPTY_SOURCE", message: "empty workflow source" }]);
    const audit = auditTraining(source);
    if (!audit.strictClean) {
      return this.observation("compile_error", audit.diagnostics);
    }
    const transformed = transformTraining(source, audit);
    const prepared = prepareWorkflow(transformed);
    if (!prepared.ok) {
      return this.observation("compile_error", bounded(prepared.diagnostics.map((d) => ({
        code: d.code ?? "compile", message: d.message, line: d.line ?? null,
      }))));
    }
    const nodeCount = (prepared.table?.asks.length ?? 0) + (prepared.table?.worldReads.length ?? 0) + (prepared.table?.holes.length ?? 0);
    if (nodeCount > this.limits.maxGraphNodes) {
      return this.observation("limit_exceeded", [{ code: "GRAPH_NODES", message: `graph nodes ${nodeCount} exceed limit ${this.limits.maxGraphNodes}` }]);
    }
    const runId = newId("run");
    const driver = new BoundedDriver({
      store: this.store, runId, runRevision: `${this.episodeId}#${this.revision}`,
      mode: "external", permission: this.permission(), gates: this.gateMap(), sandbox: this.sandbox,
      toolTimeoutMs: this.limits.toolTimeoutSeconds * 1000,
    });
    const control = new EngineControl();
    const abort = new AbortController();
    this.store.episodes.setRun(this.episodeId, runId);
    const promise = executeRun({
      store: this.store, runId, scriptText: transformed, prepared, driver, control,
      args: {}, signal: abort.signal, timeoutMs: this.limits.toolTimeoutSeconds * 1000,
      spawnWrapper: { command: "/usr/bin/sandbox-exec", argsPrefix: ["-f", this.sandbox!.profilePath] },
      ...(cache ? { importedCache: cache, resumedFrom } : {}),
    });
    const active: ActiveRun = {
      runId, driver, control, prepared, scriptText: transformed, originalSource: source, abort, promise,
    };
    promise.then((s) => { active.settlement = s; }, () => { /* settlement read via promise */ });
    this.active = active;
    return this.waitStep(active);
  }

  private async waitStep(active: ActiveRun): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (active.settlement) return this.finalObservation(active);
      const parked = active.driver.parkedAsks()[0];
      if (parked) return this.workerRequiredForAsk(active, parked);
      const openHoles = active.control.engine?.openHoles() ?? [];
      const hole = openHoles[0];
      if (hole && ![...this.pending.values()].some((p) => p.holeSiteId === hole.siteId)) {
        return this.workerRequiredForHole(active, hole.siteId, hole.name);
      }
      if (Date.now() > deadline) {
        active.abort.abort();
        await Promise.race([active.promise.catch(() => undefined), sleep(3000)]);
        return this.finalObservation(active, "timeout");
      }
      await sleep(15);
    }
  }

  private limitsRemaining(): WorkerRequest["limits_remaining"] {
    return { ...this.limits, worker_calls_remaining: Math.max(0, this.limits.maxWorkerCalls - this.workerCalls) };
  }

  /**
   * R4 strict binding: every ref must resolve, be fresh (digest = current body
   * hash), and be type-compatible with the stated T. Problems are returned,
   * never silently skipped or defaulted.
   */
  private resolveTargetsStrict(
    refs: Array<{ file: string; symbol: string; digest: string }>,
    typeText: string, typeDefs: string,
  ): { targets: Target[]; problems: string[] } {
    const targets: Target[] = [];
    const problems: string[] = [];
    for (const ref of refs) {
      let abs: string;
      try { abs = resolveInside(this.workspace, ref.file); }
      catch (e) { problems.push(`ref path rejected: ${ref.file} (${e instanceof Error ? e.message : String(e)})`); continue; }
      if (!existsSync(abs)) { problems.push(`ref file missing: ${ref.file}`); continue; }
      const source = readFileSync(abs, "utf8");
      const t = sigTargets(source, ref.file).find((x) => x.name === ref.symbol);
      if (!t) { problems.push(`unsupported or missing target: ${ref.file}#${ref.symbol}`); continue; }
      if (ref.digest && ref.digest !== t.bodyHash) {
        // Host-verified lineage: the drift is exactly this episode's own prior
        // splice (amend-resume anchors). Rebind to the current hash, which the
        // worker must ack. Any other drift is a stale/forged ref: reject.
        if (this.appliedBodyHashes.get(`${ref.file}#${ref.symbol}`) !== t.bodyHash) {
          problems.push(`stale ref for ${ref.file}#${ref.symbol}: digest does not match current body hash`);
          continue;
        }
      }
      if (typeText) {
        const contractProblems = checkContract({ source, filename: ref.file, symbol: ref.symbol, typeText, typeDefs: typeDefs || undefined });
        if (contractProblems.length > 0) {
          problems.push(`contract mismatch for ${ref.file}#${ref.symbol} vs T=${typeText}: ${contractProblems.slice(0, 3).join("; ")}`);
          continue;
        }
      }
      targets.push({
        targetId: `${ref.file}#${ref.symbol}`, file: ref.file, symbol: ref.symbol,
        bodyHash: t.bodyHash, signature: t.signature, signatureSource: t.signatureSource,
        parameters: t.parameters, bodyText: t.bodyText,
      });
    }
    return { targets, problems };
  }

  /** Bounded public test excerpts naming the symbol (scoped evidence, R3). */
  private testEvidence(symbol: string): Array<{ path: string; kind: string; text: string }> {
    const out: Array<{ path: string; kind: string; text: string }> = [];
    for (const rel of this.protectedBefore.keys()) {
      const abs = join(this.workspace, rel);
      if (!existsSync(abs)) continue;
      const lines = readFileSync(abs, "utf8").split("\n");
      const hits: string[] = [];
      lines.forEach((line, i) => {
        if (line.includes(symbol) && hits.length < 10) hits.push(`${i + 1}: ${line.trim().slice(0, 200)}`);
      });
      if (hits.length > 0) out.push({ path: rel, kind: "public-test-lines", text: hits.join("\n").slice(0, 2000) });
    }
    return out;
  }

  private async workerRequiredForAsk(active: ActiveRun, parked: ParkedAsk): Promise<Record<string, unknown>> {
    const instanceKey = `${parked.instance.siteId}@${parked.instance.ordinal}`;
    const existing = [...this.pending.values()].find((p) => p.instanceKey === instanceKey);
    if (existing) return { status: "worker_required", request: existing.request };
    let envelope: { zf?: string; spec?: unknown; refs?: unknown; typeText?: string; typeResolved?: string; typeDefs?: string } = {};
    try { envelope = JSON.parse(parked.message.instructions) as typeof envelope; } catch { envelope = {}; }
    const rawRefs = Array.isArray(envelope.refs) ? (envelope.refs as Array<Record<string, string>>) : [];
    const refs = rawRefs.map((r) => ({
      file: String(r.file ?? r.f ?? ""), symbol: String(r.symbol ?? r.s ?? ""), digest: String(r.digest ?? r.d ?? ""),
    })).filter((r) => r.file && r.symbol);
    const requestId = newId("wr");
    if (envelope.zf === "code") {
      const typeText = envelope.typeText ?? "";
      const typeDefs = envelope.typeDefs ?? "";
      const fail = async (message: string): Promise<Record<string, unknown>> => {
        this.diagnostics.push({ code: "binding_failed", message: message.slice(0, 1000) });
        active.driver.failParked(instanceKey, message);
        return this.waitStep(active);
      };
      if (!typeText) return fail("askCode requires an explicit type argument T");
      const { targets, problems } = this.resolveTargetsStrict(refs, typeText, typeDefs);
      if (problems.length > 0) return fail(`askCode binding failed: ${problems.join(" | ")}`);
      if (targets.length === 0) return fail("askCode has no bound target: pass SymbolRefs from sh.z_sig for supported exported functions");
      const obligations = targets.map((t) => t.targetId);
      const rootDigest = digestOf({ run: active.runId, site: parked.instance.siteId, obligations });
      const primary = targets[0]!;
      const request: WorkerRequest = {
        request_id: requestId, run_id: active.runId, revision: this.revision, node: instanceKey,
        kind: "code",
        target_id: primary.targetId, expected_body_hash: primary.bodyHash,
        type_declaration: typeText,
        resolved_type: envelope.typeResolved || primary.signature,
        ...(typeDefs ? { type_definitions: typeDefs } : {}),
        target_declaration: primary.signatureSource,
        parameters: primary.parameters,
        current_body: primary.bodyText,
        required_imports: fileImports(readFileSync(resolveInside(this.workspace, primary.file), "utf8"), primary.file),
        root_digest: rootDigest, obligations, scope: this.task.target_files ?? [],
        anchors: (this.task.target_files ?? []).map((f) => ({
          path: f, sha256: sha256Hex(readFileSync(join(this.workspace, f))),
        })),
        task: { task_id: this.task.task_id, user_prompt: this.task.user_prompt, target_files: this.task.target_files },
        evidence: this.testEvidence(primary.symbol),
        instructions: typeof envelope.spec === "string" ? envelope.spec : "",
        diagnostics: [],
        limits_remaining: this.limitsRemaining(),
      };
      this.pending.set(requestId, {
        requestId, kind: "code", instanceKey, targets, obligations, rootDigest,
        depth: 1, remainingTargets: [...targets], request, typeText, typeDefs,
      });
      this.workerCalls += 1;
      return { status: "worker_required", request };
    }
    const request: WorkerRequest = {
      request_id: requestId, run_id: active.runId, revision: this.revision, node: instanceKey,
      kind: "data",
      type_declaration: parked.message.typed ? JSON.stringify(parked.message.schema ?? {}) : "string",
      ...(envelope.typeResolved ? { resolved_type: envelope.typeResolved } : {}),
      ...(envelope.typeDefs ? { type_definitions: envelope.typeDefs } : {}),
      task: { task_id: this.task.task_id, user_prompt: this.task.user_prompt, target_files: this.task.target_files },
      evidence: refs.map((r) => {
        const abs = join(this.workspace, r.file);
        const t = existsSync(abs) ? sigTargets(readFileSync(abs, "utf8"), r.file).find((x) => x.name === r.symbol) : undefined;
        return { path: r.file, kind: "signature", text: t ? t.signatureSource : `${r.file}#${r.symbol}` };
      }),
      instructions: envelope.zf === "data" ? String(envelope.spec ?? "") : parked.message.instructions,
      diagnostics: [],
      limits_remaining: this.limitsRemaining(),
    };
    this.pending.set(requestId, {
      requestId, kind: "data", instanceKey, targets: [], obligations: [], rootDigest: "",
      depth: 1, remainingTargets: [], request,
    });
    this.workerCalls += 1;
    return { status: "worker_required", request };
  }

  private workerRequiredForHole(active: ActiveRun, siteId: string, name: string): Record<string, unknown> {
    const requestId = newId("wr");
    const site = active.prepared.table?.holes.find((h) => h.id === siteId);
    const request: WorkerRequest = {
      request_id: requestId, run_id: active.runId, revision: this.revision, node: siteId,
      kind: "code", target_id: siteId,
      type_declaration: site?.typeText ?? "",
      instructions: `Provide the body statements for workflow hole "${name}".`,
      limits_remaining: this.limitsRemaining(),
    };
    this.pending.set(requestId, {
      requestId, kind: "hole", holeSiteId: siteId, targets: [], obligations: [],
      rootDigest: "", depth: 1, remainingTargets: [], request,
    });
    this.workerCalls += 1;
    return { status: "worker_required", request };
  }

  private redispatch(pending: PendingWorker, note: string): Record<string, unknown> {
    this.failedAttempts += 1;
    const diagnostic: BridgeDiagnostic = { code: "host", message: note.slice(0, 1000) };
    this.diagnostics.push(diagnostic);
    // Contract/context fields stay immutable; feedback travels in diagnostics.
    const request = { ...pending.request, diagnostics: [...(pending.request.diagnostics ?? []), diagnostic] };
    pending.request = request;
    this.workerCalls += 1;
    return { status: "worker_required", request };
  }

  private async resolveWorker(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const active = this.active;
    const requestId = String(params.request_id ?? "");
    const pending = this.pending.get(requestId);
    if (!active || !pending) {
      throw Object.assign(new Error(`stale or unknown worker request: ${requestId}`), { zfacadeInfra: true });
    }
    if (params.clean_termination === false) return this.redispatch(pending, "worker sample was not cleanly terminated; return the envelope again");
    let envelope: {
      kind?: string; target_id?: string; expected_body_hash?: string; body?: string;
      value?: unknown; source?: string; children?: unknown; root_digest?: string;
    };
    try { envelope = JSON.parse(String(params.payload ?? "")) as typeof envelope; }
    catch { return this.redispatch(pending, "payload is not exactly one JSON envelope"); }
    if (!envelope || typeof envelope.kind !== "string") {
      return this.redispatch(pending, "envelope requires a kind field");
    }
    if (envelope.kind === "subgraph") {
      // R5 fail-closed: this runtime does not execute proposed subgraphs and no
      // longer advertises flat_subgraphs. Nothing is validated-as-executed here.
      return this.redispatch(pending, "subgraph expansion is not supported in this runtime; return a code or data leaf envelope, or sequence separate asks in the workflow");
    }
    if (pending.kind === "data") {
      if (envelope.kind !== "data") return this.redispatch(pending, "askData requires a data envelope; code is never accepted here");
      const parked = active.driver.parkedAsks().find((p) => `${p.instance.siteId}@${p.instance.ordinal}` === pending.instanceKey);
      if (!parked) return this.redispatch(pending, "ask no longer parked");
      if (!parked.message.typed) {
        if (typeof envelope.value !== "string") return this.redispatch(pending, "untyped ask requires a string data value");
        this.pending.delete(requestId);
        active.driver.resolveParkedText(pending.instanceKey!, envelope.value);
        return this.waitStep(active);
      }
      const verdict = await active.driver.resolveParkedData(pending.instanceKey!, envelope.value);
      if (verdict.kind === "accept") {
        this.pending.delete(requestId);
        return this.waitStep(active);
      }
      return this.redispatch(pending, verdict.kind === "reject"
        ? `schema validation failed: ${JSON.stringify(verdict.violations)}` : "submit a data value now");
    }
    if (envelope.kind !== "code" || typeof envelope.body !== "string") {
      return this.redispatch(pending, "code request requires a code envelope with a body string");
    }
    if (pending.kind === "hole") return this.resolveHole(active, pending, envelope.body);
    return this.applyCodeLeaf(active, pending, envelope, String(params.checkpoint ?? "unknown"));
  }

  private async applyCodeLeaf(
    active: ActiveRun, pending: PendingWorker,
    envelope: { target_id?: string; expected_body_hash?: string; body?: string },
    checkpoint: string,
  ): Promise<Record<string, unknown>> {
    // R4: identity and hash are required. No first-target or request fallbacks.
    if (!envelope.target_id || !envelope.expected_body_hash) {
      return this.redispatch(pending, "code envelope requires target_id and expected_body_hash from the request");
    }
    const target = pending.remainingTargets.find((t) => t.targetId === envelope.target_id);
    if (!target) {
      return this.redispatch(pending, `target identity mismatch: expected one of ${pending.remainingTargets.map((t) => t.targetId).join(", ")}`);
    }
    const abs = resolveInside(this.workspace, target.file);
    const source = readFileSync(abs, "utf8");
    const current = sigTargets(source, target.file).find((t) => t.name === target.symbol);
    if (!current) return this.redispatch(pending, `target vanished: ${target.targetId}`);
    if (current.bodyHash !== envelope.expected_body_hash || current.bodyHash !== target.bodyHash) {
      return this.redispatch(pending, `stale body hash for ${target.targetId}; re-inspect with z_sig`);
    }
    if (pending.typeText) {
      const contractProblems = checkContract({
        source, filename: target.file, symbol: target.symbol,
        typeText: pending.typeText, typeDefs: pending.typeDefs || undefined,
      });
      if (contractProblems.length > 0) {
        return this.redispatch(pending, `contract no longer matches ${target.targetId}: ${contractProblems.slice(0, 3).join("; ")}`);
      }
    }
    const key = replayKey({
      sourceHash: sha256Hex(source), contractHash: digestOf({ target: target.targetId, signature: target.signature }),
      dependencyHashes: [], snapshotHash: current.bodyHash, facadeVersion: FACADE_VERSION,
      workerCheckpoint: checkpoint, policyHash: this.gatesDigest,
    });
    let next: string;
    try { next = spliceBody(source, target.file, target.symbol, current.bodyHash, envelope.body!); }
    catch (e) { return this.redispatch(pending, e instanceof Error ? e.message : String(e)); }
    const after = sigTargets(next, target.file).find((t) => t.name === target.symbol);
    if (!after || after.signature !== current.signature || after.signatureSource !== current.signatureSource) {
      return this.redispatch(pending, `splice changed the declaration of ${target.targetId}; only the body may change`);
    }
    const diags = typecheckFile(abs, next);
    if (diags.length > 0) return this.redispatch(pending, `spliced source fails typecheck: ${diags.slice(0, 5).join("; ")}`);
    const cached = this.sourceCache.get(key);
    if (cached === sha256Hex(next) && sha256Hex(source) === cached) {
      // Source already at the spliced state: reuse without repeating the write.
    } else {
      const [siteId = "ask#0", ordinalRaw = "1"] = (pending.instanceKey ?? "").split("@");
      try {
        await active.driver.tools.execute("Write", { path: target.file, content: next }, {
          runId: active.runId, runRevision: `${this.episodeId}#${this.revision}`,
          siteId, ordinal: Number(ordinalRaw), toolOrdinal: 700 + this.workerCalls,
          permission: this.permission(), toolNameOverride: "code-splice",
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/protected|allowlist|escapes/.test(message)) this.policyViolation = true;
        return this.redispatch(pending, `write denied by effect authority: ${message}`);
      }
      this.sourceCache.set(key, sha256Hex(next));
    }
    pending.remainingTargets = pending.remainingTargets.filter((t) => t.targetId !== target.targetId);
    target.bodyHash = sigTargets(next, target.file).find((t) => t.name === target.symbol)?.bodyHash ?? target.bodyHash;
    this.appliedBodyHashes.set(target.targetId, target.bodyHash);
    if (pending.remainingTargets.length > 0) {
      const nextTarget = pending.remainingTargets[0]!;
      pending.request = {
        ...pending.request,
        target_id: nextTarget.targetId, expected_body_hash: nextTarget.bodyHash,
        target_declaration: nextTarget.signatureSource, parameters: nextTarget.parameters,
        current_body: nextTarget.bodyText,
        required_imports: fileImports(readFileSync(resolveInside(this.workspace, nextTarget.file), "utf8"), nextTarget.file),
        evidence: this.testEvidence(nextTarget.symbol),
      };
      return this.redispatchNote(pending, `applied ${target.targetId}; continue with next target`);
    }
    this.pending.delete(pending.requestId);
    const verdict = await active.driver.resolveParkedData(pending.instanceKey!, {
      artifactId: `art_${key.slice(0, 16)}`, targetId: target.targetId, applied: true,
    });
    if (verdict.kind !== "accept") {
      this.diagnostics.push({ code: "submit_verdict", message: `code artifact submit verdict: ${verdict.kind}` });
    }
    return this.waitStep(active);
  }

  private redispatchNote(pending: PendingWorker, note: string): Record<string, unknown> {
    this.workerCalls += 1;
    const diagnostic: BridgeDiagnostic = { code: "host", message: note.slice(0, 1000) };
    pending.request = { ...pending.request, diagnostics: [...(pending.request.diagnostics ?? []), diagnostic] };
    return { status: "worker_required", request: pending.request };
  }

  private async resolveHole(active: ActiveRun, pending: PendingWorker, body: string): Promise<Record<string, unknown>> {
    const engine = active.control.engine;
    if (!engine || !active.prepared.table) return this.redispatch(pending, "engine control unavailable");
    const spliced = spliceHoleBody(active.scriptText, active.prepared.table, pending.holeSiteId!, body);
    if (!spliced) return this.redispatch(pending, "hole site not found or already filled in source");
    const prepared2 = prepareWorkflow(spliced.text);
    if (!prepared2.ok || !prepared2.table || !prepared2.askSpecs) {
      return this.redispatch(pending, `filled script fails compile: ${JSON.stringify(bounded(prepared2.diagnostics, 5))}`);
    }
    const stability = checkSiteStability(active.prepared.table, prepared2.table, pending.holeSiteId!, spliced.insertedAtLine, spliced.insertedLines);
    if (!stability.ok) return this.redispatch(pending, `site stability check failed: ${JSON.stringify(stability)}`);
    const lowered = lowerWorkflowScript(spliced.text);
    const code = lowered.lowered?.holeBodies[pending.holeSiteId!];
    if (!lowered.ok || !code) return this.redispatch(pending, "lowering the filled script produced no hole body");
    const { phaseNames, holes } = collectPhaseNames(prepared2.analysis?.flow);
    const result = engine.fillHole({
      siteId: pending.holeSiteId!, code,
      script: { text: spliced.text, hash: prepared2.scriptHash },
      askSpecs: prepared2.askSpecs, sitePhases: prepared2.sitePhases ?? new Map(),
      phaseNames, holes,
    });
    if (!result.ok) return this.redispatch(pending, `fillHole rejected: ${result.reason}`);
    active.scriptText = spliced.text;
    active.prepared = prepared2;
    this.pending.delete(pending.requestId);
    return this.waitStep(active);
  }

  private buildImportedCache(priorRunId: string, invalidated: Set<string>): ImportedRunCache {
    const store = this.store!;
    const actors = new Map<string, {
      persona: { name?: string; system?: string; model?: string };
      entries: Array<{ inputHash: string; result: unknown; messageBoundary: number }>;
      transcriptSourceSessionId: string;
    }>();
    const nodes = store.journal.listNodes(priorRunId, { kinds: "all", withResult: true });
    const actorRows = store.journal.listActors(priorRunId, { withPersona: true });
    for (const actor of actorRows) {
      if (!actor.name) continue;
      const entries = nodes
        .filter((n) => n.kind === "ask" && n.actorSiteId === actor.siteId && n.actorOrdinal === actor.ordinal && n.status === "completed" && n.messageBoundary !== undefined)
        .sort((a, b) => (a.actorSeq ?? 0) - (b.actorSeq ?? 0))
        .map((n) => ({ inputHash: n.inputHash, result: n.result, messageBoundary: n.messageBoundary! }));
      // Longest completed prefix only: stop at the first actorSeq gap.
      const prefix: typeof entries = [];
      const sorted = [...nodes.filter((n) => n.kind === "ask" && n.actorSiteId === actor.siteId && n.actorOrdinal === actor.ordinal)]
        .sort((a, b) => (a.actorSeq ?? 0) - (b.actorSeq ?? 0));
      for (let i = 0; i < sorted.length; i++) {
        const n = sorted[i]!;
        // R6: an invalidated ask and every downstream decision stay live.
        if (invalidated.has(n.siteId)) break;
        if (n.status !== "completed" || n.messageBoundary === undefined || (n.actorSeq ?? -1) !== i) break;
        prefix.push({ inputHash: n.inputHash, result: n.result, messageBoundary: n.messageBoundary });
      }
      if (entries.length >= 0 && actor.sessionId) {
        actors.set(actor.name, {
          persona: actor.persona ?? {}, entries: prefix,
          transcriptSourceSessionId: actor.sessionId,
        });
      }
    }
    const world = new Map<string, Array<{ inputHash: string; kind: "world-read" | "world-run"; result: unknown }>>();
    for (const n of nodes) {
      // R6: verification observations (world-run: z_verify/world.run) are never
      // imported. Historical receipts stay in the journal; successors always
      // observe gates fresh against current workspace state.
      if (n.kind !== "world-read" || n.status !== "completed") continue;
      if (invalidated.has(n.siteId)) continue;
      const q = world.get(n.inputHash) ?? [];
      q.push({ inputHash: n.inputHash, kind: n.kind, result: n.result });
      world.set(n.inputHash, q);
    }
    return { actors, world } as unknown as ImportedRunCache;
  }

  private async amend(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.active && !this.store) throw Object.assign(new Error("episode not open"), { zfacadeInfra: true });
    if (Number(params.revision ?? -1) !== this.revision) {
      return { status: "stale_revision", diagnostics: [`expected revision ${this.revision}`], receipt: this.buildReceipt("stale_revision") };
    }
    const holeId = String(params.hole_id ?? "");
    const prior = this.active;
    const known = prior?.prepared.table
      ? new Set([...prior.prepared.table.holes.map((h) => h.id), ...prior.prepared.table.asks.map((a) => a.id)])
      : new Set<string>();
    if (prior && !known.has(holeId)) {
      return { status: "unknown_hole", diagnostics: [`unknown stable hole id: ${holeId}`], receipt: this.buildReceipt("unknown_hole") };
    }
    // Invalidation from the compiler causality graph of the PRIOR script.
    // R6: the invalidated SET (not just its size) filters the imported cache.
    let invalidated = new Set<string>([holeId]);
    if (prior?.prepared.analysis?.causality) {
      const graph = prior.prepared.analysis.causality;
      const depNodes = graph.steps.map((s) => ({
        id: s.id, deps: graph.edges.filter((e) => e.to === s.id).map((e) => e.from),
      }));
      try {
        invalidated = invalidatedNodes(depNodes, new Set([holeId]));
      } catch { invalidated = new Set([holeId]); }
    }
    this.invalidatedCount = invalidated.size;
    let cache: ImportedRunCache | undefined;
    let priorRunId: string | undefined;
    if (prior) {
      priorRunId = prior.runId;
      if (!prior.settlement) {
        prior.abort.abort();
        await Promise.race([prior.promise.catch(() => undefined), sleep(5000)]);
      }
      cache = this.buildImportedCache(priorRunId, invalidated);
    }
    this.pending.clear();
    this.revision += 1;
    return this.submit(params, true, cache, priorRunId);
  }

  private async runFinalGates(active: ActiveRun): Promise<{ typecheckPass: boolean; testsPass: boolean; receiptIds: string[] }> {
    const receiptIds: string[] = [];
    let typecheckPass = true;
    let testsPass = true;
    let ordinal = 900;
    for (const [gateId, gate] of Object.entries(this.gates)) {
      const run = async (argv: string[], label: string): Promise<boolean> => {
        const out = await active.driver.tools.execute("Bash", { argv }, {
          runId: active.runId, runRevision: `${this.episodeId}#${this.revision}`,
          siteId: "gate#final", ordinal: ordinal++, toolOrdinal: 0,
          permission: this.permission(), toolNameOverride: `gate:${gateId}:${label}`, authTool: "world.run",
          timeoutMs: this.limits.toolTimeoutSeconds * 1000, sandbox: this.sandbox,
        });
        receiptIds.push(out.effect.operationId);
        return (out.result as { exitCode: number }).exitCode === 0;
      };
      if (gate.typecheckArgv.length > 0) typecheckPass = (await run(gate.typecheckArgv, "typecheck-final")) && typecheckPass;
      testsPass = (await run(gate.argv, "test-final")) && testsPass;
    }
    return { typecheckPass, testsPass, receiptIds };
  }

  private protectedUnchanged(): boolean {
    for (const [rel, before] of this.protectedBefore) {
      const abs = join(this.workspace, rel);
      const now = existsSync(abs) ? sha256Hex(readFileSync(abs)) : "<absent>";
      if (now !== before) return false;
    }
    return true;
  }

  private buildReceipt(status: string, extra?: Partial<EpisodeReceipt>, active?: ActiveRun): EpisodeReceipt {
    const store = this.store;
    const run = active ?? this.active;
    const runId = run?.runId ?? "";
    const effects = store && runId ? store.effects.repo.listByRun(runId) : [];
    const unchanged = this.protectedUnchanged();
    // R1: unresolved work is part of the receipt, computed from live authority
    // state at receipt time — never cleared away before scoring.
    const openHoles = (run?.control?.engine?.openHoles() ?? []).map((h) => h.siteId);
    const pendingWorkers = [...this.pending.keys()];
    const parkedAsks = run ? run.driver.parkedAsks().map((p) => `${p.instance.siteId}@${p.instance.ordinal}`) : [];
    const pendingEffects = effects.filter((e) => ["intended", "authorized", "dispatched", "started"].includes(e.state));
    const heldEffects = effects.filter((e) => e.state === "outcome_unknown");
    const deniedEffects = effects.filter((e) => e.state === "denied");
    const base: EpisodeReceipt = {
      verified_green: false, compile_clean: false, meaningful_progress: false,
      no_unresolved_holes: openHoles.length === 0 && pendingWorkers.length === 0 && parkedAsks.length === 0,
      typecheck_pass: false, tests_pass: false,
      tests_unchanged: unchanged,
      policy_violation: this.policyViolation || deniedEffects.length > 0 || (run?.driver.denials.length ?? 0) > 0,
      test_tampering: !unchanged,
      run_id: runId, episode_id: this.episodeId, revision: this.revision,
      facade_version: FACADE_VERSION,
      source_hash: run ? sha256Hex(run.originalSource) : "",
      graph_hash: run?.prepared.analysis?.causality ? digestOf(run.prepared.analysis.causality.steps.map((s) => s.id)) : "",
      contract_hash: digestOf({ gates: this.gatesDigest, limits: this.limits }),
      gates_digest: this.gatesDigest,
      effect_receipt_ids: effects.map((e) => e.operationId),
      test_receipt_ids: [],
      failed_attempts: this.failedAttempts + (run?.driver.failedAttempts ?? 0),
      max_depth: this.maxDepth,
      reused_nodes: run?.driver.reusedNodes ?? 0,
      invalidated_nodes: this.invalidatedCount,
      elapsed_ms: Date.now() - this.startedAt,
      provider_label: "bridge-external-worker",
      settlement_status: status,
      cancelled: status === "cancelled",
      open_holes: openHoles,
      pending_workers: pendingWorkers,
      pending_effect_ids: pendingEffects.map((e) => e.operationId),
      held_effect_ids: heldEffects.map((e) => e.operationId),
      denied_effect_ids: deniedEffects.map((e) => e.operationId),
    };
    const merged = { ...base, ...(extra ?? {}) };
    // Classification fields are recomputed from authority state, never overridden.
    merged.settlement_status = status;
    merged.cancelled = status === "cancelled";
    merged.open_holes = base.open_holes;
    merged.pending_workers = base.pending_workers;
    merged.pending_effect_ids = base.pending_effect_ids;
    merged.held_effect_ids = base.held_effect_ids;
    merged.denied_effect_ids = base.denied_effect_ids;
    merged.policy_violation = base.policy_violation;
    merged.tests_unchanged = unchanged;
    merged.test_tampering = !unchanged;
    merged.no_unresolved_holes = base.no_unresolved_holes;
    // R1: the one terminal-success predicate. Errored/stopped/cancelled/timeout
    // settlements can never be green, however fresh final gates look.
    merged.verified_green = isTerminalSuccess(status, merged);
    return merged;
  }

  private observation(status: string, diagnostics: unknown[]): Record<string, unknown> {
    return {
      status, diagnostics: toDiagnostics(diagnostics),
      holes: { revision: this.revision, open: [] as string[] },
      receipt: this.buildReceipt(status),
    };
  }

  private async finalObservation(active: ActiveRun, statusOverride?: string): Promise<Record<string, unknown>> {
    const settlement: RunSettlement | undefined = active.settlement ?? await Promise.race([
      active.promise, sleep(100).then(() => undefined),
    ]);
    const status = statusOverride ?? settlement?.status ?? "unknown";
    const openHoles = active.control.engine?.openHoles() ?? [];
    const gates = await this.runFinalGates(active);
    const effects = this.store!.effects.repo.listByRun(active.runId);
    const wroteSomething = effects.some((e) => e.state === "completed" && (e.toolName === "code-splice" || e.toolName === "Write" || e.toolName === "Edit"));
    const receipt = this.buildReceipt(status, {
      compile_clean: true,
      // Progress credit requires real completed work; fresh gates alone are not progress.
      meaningful_progress: status === "completed" || wroteSomething,
      typecheck_pass: gates.typecheckPass, tests_pass: gates.testsPass,
      test_receipt_ids: [...active.driver.gateReceiptIds, ...gates.receiptIds],
    }, active);
    const diagnostics: BridgeDiagnostic[] = [...this.diagnostics];
    if (settlement?.status === "errored") diagnostics.push({ code: "run_errored", message: String(settlement.error.message ?? settlement.error).slice(0, 1000) });
    if (settlement?.status === "stopped") diagnostics.push({ code: "run_stopped", message: `run stopped: ${settlement.reason}` });
    this.store!.episodes.setStatus(this.episodeId, status);
    return {
      status, diagnostics: bounded(diagnostics),
      holes: { revision: this.revision, open: openHoles.map((h) => h.siteId) },
      receipt,
    };
  }

  private async cancel(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const active = this.active;
    if (!active) return { status: "cancelled", receipt: this.buildReceipt("cancelled") };
    if (!active.settlement) {
      active.abort.abort();
      await Promise.race([active.promise.catch(() => undefined), sleep(5000)]);
    }
    void params;
    // R1: receipt is computed WITH pending work retained; only then cleared.
    const result = await this.finalObservation(active, "cancelled");
    this.pending.clear();
    return result;
  }

  private async close(): Promise<Record<string, unknown>> {
    if (this.closed) return { status: "closed" };
    this.closed = true;
    if (this.active && !this.active.settlement) {
      this.active.abort.abort();
      await Promise.race([this.active.promise.catch(() => undefined), sleep(3000)]);
    }
    this.pending.clear();
    try { this.store?.release(); } catch { /* release best effort on close */ }
    if (this.sandbox) { destroySandbox(this.sandbox); this.sandbox = undefined; }
    return { status: "closed" };
  }
}

export async function serveBridge(): Promise<void> {
  const server = new BridgeServer();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const reply = await server.handleLine(line);
    if (reply !== undefined) process.stdout.write(reply + "\n");
  }
}

