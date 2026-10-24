import type { Grant } from "./effects.js";
import { TOOL_NAMES, ZfacadeError } from "./effects.js";

/**
 * Trusted user/CLI configuration (plan 8.3 precedence). Workspace files can
 * never supply grants, credentials, or provider endpoints.
 */
export interface ZfacadeConfig {
  provider?: {
    /**
     * - `openai`: hosted OpenAI API for live testing/shakeout (ALIGNMENT G3).
     *   baseUrl defaults to https://api.openai.com/v1; key from apiKeyEnv (never stored).
     * - `openai-compatible`: local OpenAI-compatible server (loopback only).
     * - `deterministic-test`: offline double; never default; receipts labeled.
     */
    kind: "openai" | "openai-compatible" | "deterministic-test";
    baseUrl?: string;
    modelId?: string;
    /** Reference to an environment variable holding the key. Values are never persisted. */
    apiKeyEnv?: string;
    deterministicScriptPath?: string;
  };
  grants?: Grant[];
  retention?: { maxArtifactBytes?: number; keepRuns?: number };
  limits?: { toolTimeoutMs?: number; maxOutputBytes?: number; maxSteps?: number };
}

const TOOL_SET = new Set<string>([...TOOL_NAMES, "world.run"]);

export function validateConfig(raw: unknown): ZfacadeConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ZfacadeError("ConfigInvalid", "config must be an object");
  const cfg = raw as ZfacadeConfig;
  if (cfg.provider !== undefined) {
    const p = cfg.provider;
    if (p.kind !== "openai" && p.kind !== "openai-compatible" && p.kind !== "deterministic-test") {
      throw new ZfacadeError("ConfigInvalid", `unknown provider kind: ${String(p.kind)}`);
    }
    if (p.kind === "deterministic-test") {
      if (!p.deterministicScriptPath) {
        throw new ZfacadeError("ConfigInvalid", "deterministic-test provider requires deterministicScriptPath");
      }
    } else if (p.kind === "openai") {
      if (!p.modelId) {
        throw new ZfacadeError("ConfigInvalid", "openai provider requires modelId");
      }
      if (p.baseUrl && !/^https:\/\/(api\.openai\.com|127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(p.baseUrl)) {
        throw new ZfacadeError("ConfigInvalid", "openai provider baseUrl must be api.openai.com or loopback");
      }
    } else {
      // openai-compatible: local endpoints only (D2). Hosted OpenAI uses kind "openai".
      if (!p.baseUrl || !p.modelId) {
        throw new ZfacadeError("ConfigInvalid", "openai-compatible provider requires baseUrl and modelId");
      }
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(p.baseUrl)) {
        throw new ZfacadeError("ConfigInvalid", "openai-compatible baseUrl must be a local loopback endpoint (use kind \"openai\" for hosted OpenAI)");
      }
    }
  }
  for (const g of cfg.grants ?? []) {
    if (!g.id || !TOOL_SET.has(g.tool) || typeof g.match !== "string" || g.match.length === 0) {
      throw new ZfacadeError("ConfigInvalid", `invalid grant: ${JSON.stringify(g)}`);
    }
  }
  return cfg;
}

/** Redacted copy safe for receipts/logs: never contains key material. */
export function redactConfig(cfg: ZfacadeConfig): unknown {
  return JSON.parse(JSON.stringify(cfg)) as unknown;
}
