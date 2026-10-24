import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderPort, ZfacadeConfig } from "@zfacade/contracts";
import { validateConfig, ZfacadeError } from "@zfacade/contracts";
import { stateRoot } from "@zfacade/core";
import { DeterministicProvider, OpenAICompatibleProvider } from "@zfacade/agent";

/** Trusted user config only (never workspace files): ~/.zfacade/config.json or --config path. */
export function loadConfig(explicitPath?: string, env: NodeJS.ProcessEnv = process.env): ZfacadeConfig {
  const path = explicitPath ?? join(stateRoot(env), "config.json");
  if (!existsSync(path)) {
    if (explicitPath) throw new ZfacadeError("ConfigInvalid", `config file not found: ${explicitPath}`);
    return {};
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch (e) { throw new ZfacadeError("ConfigInvalid", `cannot parse ${path}: ${e instanceof Error ? e.message : String(e)}`); }
  return validateConfig(raw);
}

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

export function buildProvider(cfg: ZfacadeConfig, env: NodeJS.ProcessEnv = process.env): ProviderPort {
  const p = cfg.provider;
  if (!p) {
    throw new ZfacadeError("ProviderNotConfigured",
      "no provider configured. For live OpenAI testing set provider.kind=\"openai\" in ~/.zfacade/config.json (or --config) and OPENAI_API_KEY in the environment. deterministic-test is for offline tests only.");
  }
  if (p.kind === "deterministic-test") return DeterministicProvider.fromFile(p.deterministicScriptPath!);
  const apiKeyEnv = p.apiKeyEnv ?? (p.kind === "openai" ? "OPENAI_API_KEY" : undefined);
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
  if (p.kind === "openai") {
    return new OpenAICompatibleProvider(p.baseUrl ?? OPENAI_DEFAULT_BASE, p.modelId!, apiKey);
  }
  return new OpenAICompatibleProvider(p.baseUrl!, p.modelId!, apiKey);
}

/**
 * Load KEY=value pairs from a .env file into a plain object.
 * Does not override keys already present in `env`. Used by live canaries only.
 */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && value && env[key] === undefined) out[key] = value;
  }
  return out;
}
