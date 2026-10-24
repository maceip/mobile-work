/** Coding tools exposed to the bounded actor. Deferred surfaces are absent, never stubbed. */
export const TOOL_NAMES = ["Read", "Write", "Edit", "ApplyPatch", "Bash", "Grep", "Glob"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const READONLY_TOOLS: ReadonlySet<ToolName> = new Set(["Read", "Grep", "Glob"]);

export type EffectState =
  | "intended" | "authorized" | "dispatched" | "started"
  | "completed" | "failed" | "denied" | "outcome_unknown" | "cancelled";

export interface EffectIntent {
  runId: string;
  runRevision: string;
  siteId: string;
  ordinal: number;
  toolOrdinal: number;
  toolName: string;
  input: unknown;
  cwd: string;
}

export interface EffectRecord extends EffectIntent {
  operationId: string;
  inputDigest: string;
  idempotencyKey: string;
  state: EffectState;
  authorization?: unknown;
  result?: unknown;
  artifactRef?: string;
  preHash?: string;
  postHash?: string;
  pid?: number;
  createdAt: number;
  dispatchedAt?: number;
  settledAt?: number;
}

export type PermissionDecision =
  | { kind: "allow"; grantId: string; reason: string }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string };

/** A trusted-config grant. Binds exact tool + matcher; changed input needs a fresh decision. */
export interface Grant {
  id: string;
  tool: ToolName | "world.run";
  /** Exact argv prefix for Bash/world.run, or workspace-relative path prefix for file tools. */
  match: string;
  cwd?: string;
}

export interface QuestionRecord {
  questionId: string;
  runId: string;
  kind: "clarification" | "permission";
  operationId?: string;
  payload: unknown;
  policyDigest: string;
  status: "pending" | "answered" | "denied" | "expired";
  answer?: unknown;
  createdAt: number;
  answeredAt?: number;
}

export const EXIT = {
  ok: 0,
  pendingHuman: 2,
  recoveryHold: 3,
  denied: 4,
  infra: 5,
} as const;

export class ZfacadeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ZfacadeError";
    this.code = code;
  }
}
