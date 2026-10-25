import { digestOf } from "./hash.js";

/**
 * Training bridge protocol v1 (zfacade-tinker docs/bridge_protocol.md).
 * R5: flat_subgraphs withdrawn from the pilot — subgraph envelopes fail closed.
 */
export const REQUIRED_CAPABILITIES = [
  "compiled_facade", "typed_code_splice", "typed_data_validation",
  "dependency_replay", "isolated_effects", "immutable_test_gates",
] as const;

export const BRIDGE_MAX_BYTES = 1_000_000;

export interface BridgeRequest {
  protocol: 1;
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export type BridgeReply =
  | { protocol: 1; id: number; result: Record<string, unknown> }
  | { protocol: 1; id: number; error: { code: string; message: string } };

export interface GateSpec {
  argv: string[];
  typecheckArgv: string[];
  protectedFiles: string[];
}

export interface EpisodeLimits {
  maxWorkerCalls: number;
  maxGraphNodes: number;
  maxSubgraphExpansions: number;
  toolTimeoutSeconds: number;
}

export interface BridgeDiagnostic {
  code: string;
  message: string;
  line?: number | null;
  column?: number | null;
  file?: string;
}

/** One module-local declaration a worker body may legitimately reference. */
export interface LocalDeclaration {
  name: string;
  kind: "function" | "variable" | "class" | "interface" | "type" | "enum" | "import";
  exported?: boolean;
  /** Bounded declaration header (signature/alias/initializer shape), never a function body. */
  signature: string;
  /** 1-based [startLine, endLine] in the declaring file. */
  span: [number, number];
  imported_from?: string;
  imported_name?: string;
}

export interface WorkerRequest {
  request_id: string;
  run_id: string;
  revision: number;
  node: string;
  kind: "code" | "data" | "subgraph";
  target_id?: string;
  expected_body_hash?: string;
  /** Declared T source text (may be an alias name). */
  type_declaration?: string;
  /** Checker-resolved expansion of T (never a bare alias alone). */
  resolved_type?: string;
  /** Alias/interface declarations from the workflow source that T depends on. */
  type_definitions?: string;
  /** Actual target declaration line, e.g. `export function sum(left: number, ...): number`. */
  target_declaration?: string;
  parameters?: Array<{ name: string; type: string; optional?: boolean; rest?: boolean }>;
  /** Current target body text (public stub/source, never a solution). */
  current_body?: string;
  required_imports?: string[];
  /**
   * Same-file declarations (exports and non-exports) plus direct import
   * bindings, with exact names. Worker bodies may only reference
   * identifiers grounded here, in parameters, or in required_imports;
   * signatures never contain another function's body (no solutions).
   */
  local_declarations?: LocalDeclaration[];
  root_digest?: string;
  obligations?: string[];
  scope?: string[];
  anchors?: Array<{ path: string; sha256: string }>;
  /** Immutable root task specification visible to the policy. */
  task?: { task_id?: string; user_prompt?: string; target_files?: string[] };
  /** Scoped public evidence (read-only task test excerpts naming the target). */
  evidence?: Array<{ path: string; kind: string; text: string }>;
  instructions?: string;
  /** Host diagnostics from rejected attempts; contract fields never mutate. */
  diagnostics?: BridgeDiagnostic[];
  limits_remaining: EpisodeLimits & { worker_calls_remaining: number };
}

export interface EpisodeReceipt {
  verified_green: boolean;
  compile_clean: boolean;
  meaningful_progress: boolean;
  no_unresolved_holes: boolean;
  typecheck_pass: boolean;
  tests_pass: boolean;
  tests_unchanged: boolean;
  policy_violation: boolean;
  test_tampering: boolean;
  run_id: string;
  episode_id: string;
  revision: number;
  facade_version: string;
  source_hash: string;
  graph_hash: string;
  contract_hash: string;
  gates_digest: string;
  effect_receipt_ids: string[];
  test_receipt_ids: string[];
  failed_attempts: number;
  max_depth: number;
  reused_nodes: number;
  invalidated_nodes: number;
  elapsed_ms: number;
  provider_label: string;
  /** Worker dispatches (askCode/askData) so far; shaping credit requires >= 1. */
  worker_calls: number;
  /** R1 terminal-success evidence: consumers must require "completed". */
  settlement_status: string;
  cancelled: boolean;
  open_holes: string[];
  pending_workers: string[];
  /** Non-terminal effect receipts (intended/authorized/dispatched/started). */
  pending_effect_ids: string[];
  /** Dispatched effects with unknown outcomes (recovery holds). */
  held_effect_ids: string[];
  /** Effects denied by the permission authority during this run. */
  denied_effect_ids: string[];
}

/**
 * The single terminal-success predicate (R1). Bridge and consumer must agree:
 * verified_green is true only when the workflow itself completed cleanly.
 * Independent final tests passing never erase workflow violations.
 */
export function isTerminalSuccess(status: string, r: {
  compile_clean: boolean; typecheck_pass: boolean; tests_pass: boolean;
  tests_unchanged: boolean; no_unresolved_holes: boolean;
  policy_violation: boolean; test_tampering: boolean;
  pending_effect_ids: string[]; held_effect_ids: string[]; denied_effect_ids: string[];
}): boolean {
  return status === "completed"
    && r.compile_clean && r.typecheck_pass && r.tests_pass
    && r.tests_unchanged && r.no_unresolved_holes
    && !r.policy_violation && !r.test_tampering
    && r.pending_effect_ids.length === 0
    && r.held_effect_ids.length === 0
    && r.denied_effect_ids.length === 0;
}

/** Port of tinker contracts.validate_subgraph: strict obligation contraction. */
export function validateSubgraph(
  parent: { obligations: string[]; scope: string[]; root_digest: string },
  children: Array<{ obligations: string[]; scope: string[]; root_digest: string }>,
): void {
  const p = new Set(parent.obligations);
  const scope = new Set(parent.scope);
  if (p.size === 0 || children.length === 0) throw new Error("empty decomposition");
  const covered = new Set<string>();
  for (const c of children) {
    const obligations = new Set(c.obligations);
    if (obligations.size === 0 || ![...obligations].every((o) => p.has(o)) || obligations.size >= p.size) {
      throw new Error("child obligations must be a strict subset");
    }
    if (!c.scope.every((s) => scope.has(s)) || c.root_digest !== parent.root_digest) {
      throw new Error("scope expansion or changed root anchor");
    }
    for (const o of obligations) {
      if (covered.has(o)) throw new Error("duplicate obligations in sibling decomposition");
      covered.add(o);
    }
  }
  if (covered.size !== p.size || ![...p].every((o) => covered.has(o))) {
    throw new Error("decomposition drops obligations");
  }
}

/** Port of tinker contracts.invalidated_nodes: transitive dependents of changed nodes. */
export function invalidatedNodes(
  nodes: Array<{ id: string; deps: string[] }>,
  changed: Set<string>,
): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new Error("duplicate node ID");
  for (const c of changed) if (!byId.has(c)) throw new Error("unknown node ID");
  for (const n of nodes) for (const d of n.deps) if (!byId.has(d)) throw new Error("unknown dependency");
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error("cycle in graph");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of byId.get(key)!.deps) visit(dep);
    visiting.delete(key); visited.add(key);
  };
  for (const key of byId.keys()) visit(key);
  const result = new Set(changed);
  for (;;) {
    let grew = false;
    for (const n of nodes) {
      if (!result.has(n.id) && n.deps.some((d) => result.has(d))) { result.add(n.id); grew = true; }
    }
    if (!grew) return result;
  }
}

/** Port of tinker contracts.replay_key (digest over named cache identity parts). */
export function replayKey(parts: {
  sourceHash: string; contractHash: string; dependencyHashes: string[];
  snapshotHash: string; facadeVersion: string; workerCheckpoint: string; policyHash: string;
}): string {
  return digestOf(parts);
}
