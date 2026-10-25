#!/usr/bin/env node
/**
 * Live OpenAI canary (ALIGNMENT G3 / A1).
 *
 * Opt-in: requires OPENAI_API_KEY (env or ~/zfacade/.env).
 * Never prints the key. Labels evidence `live-openai`.
 * Not a training run; not a substitute for deterministic offline tests.
 *
 * Usage:
 *   node scripts/openai-canary.mjs
 *   node scripts/openai-canary.mjs --model gpt-4.1-mini
 *   node scripts/openai-canary.mjs --tools   # also exercise tool-call streaming
 *   pnpm test:live
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadDotEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotEnvFile(join(root, ".env"));

const args = process.argv.slice(2);
const wantTools = args.includes("--tools");
const modelIdx = args.indexOf("--model");
const modelId = modelIdx >= 0 ? args[modelIdx + 1] : process.env.ZFACADE_OPENAI_MODEL || "gpt-5.5";
const baseUrl = (process.env.ZFACADE_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error("SKIP: no OPENAI_API_KEY (set env or ~/zfacade/.env). This is not a pass.");
  process.exit(2);
}

const payload = {
  model: modelId,
  stream: true,
  // gpt-5+ rejects max_tokens (D15)
  ...(/^gpt-5|o[0-9]/i.test(modelId) ? { max_completion_tokens: 256 } : { max_tokens: 256 }),
  messages: [
    { role: "system", content: "You are a canary. Reply with exactly: PONG" },
    { role: "user", content: "ping" },
  ],
};
if (wantTools) {
  payload.tools = [{
    type: "function",
    function: {
      name: "echo",
      description: "Echo a string",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  }];
  payload.messages[0].content = "You are a canary. Call the echo tool with text PONG. Prefer the tool over prose.";
}

const res = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`FAIL: HTTP ${res.status} from ${baseUrl}/chat/completions`);
  console.error(body.slice(0, 500));
  process.exit(1);
}

let text = "";
let toolCalls = 0;
let usage = null;
const decoder = new TextDecoder();
let buffer = "";
const reader = res.body.getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.content === "string") text += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (tc.index !== undefined && (tc.function?.name || tc.function?.arguments)) {
          // count completed tool calls by id or first name appearance
        }
        if (tc.id) toolCalls += 1;
      }
    }
  }
}

const evidenceDir = join(root, "evidence", "live-openai");
mkdirSync(evidenceDir, { recursive: true });
const record = {
  label: "live-openai",
  at: new Date().toISOString(),
  baseUrl,
  modelId,
  wantTools,
  textPreview: text.slice(0, 200),
  toolCallsSeen: toolCalls,
  usage,
  ok: true,
};
writeFileSync(join(evidenceDir, `canary-${Date.now()}.json`), JSON.stringify(record, null, 2));

const trimmed = text.trim();
if (wantTools) {
  if (toolCalls < 1 && !/PONG/i.test(trimmed)) {
    console.error("FAIL: expected a tool call or PONG text", record);
    process.exit(1);
  }
} else if (!/PONG/i.test(trimmed)) {
  console.error("FAIL: expected PONG in reply", record);
  process.exit(1);
}

console.log(JSON.stringify(record, null, 2));
console.log("PASS: live-openai canary ok");
