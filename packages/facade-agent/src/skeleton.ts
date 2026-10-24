import { sha256Hex } from "@zfacade/contracts";
import type { ToolSpec } from "@zfacade/contracts";

/**
 * Trusted host-authored coding skeleton (plan 4.1). Bundled and hash-pinned;
 * model output enters only as data (ask instructions/answers), never as code.
 * Each ask is exactly one bounded model step in the driver; the loop lives
 * here so the engine sees every step as its own node.
 */
export const SKELETON_SOURCE = [
  'phase("coding");',
  'const coder = agent("coder", { system: "You are the zfacade coding actor. Use tools to complete the task. Reply with a brief summary when done." });',
  'const task = String(args.task ?? "");',
  "let stepText = await coder.ask(task);",
  "let step = JSON.parse(stepText);",
  "let guard = 0;",
  "while (!step.done && guard < 200) {",
  "  guard += 1;",
  '  stepText = await coder.ask("Continue the task. Previous step: " + stepText);',
  "  step = JSON.parse(stepText);",
  "}",
  "return step;",
  "",
].join("\n");

export const SKELETON_HASH = sha256Hex(SKELETON_SOURCE);
export const SKELETON_VERSION = "skeleton-1";

export interface StepEnvelope {
  done: boolean;
  summary: string;
  toolResults: Array<{ tool: string; ok: boolean; text: string; operationId: string }>;
  providerLabel: string;
}

export const CODING_TOOLS: ToolSpec[] = [
  { name: "Read", description: "Read a workspace file as UTF-8 text.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "Write", description: "Write (atomically replace) a workspace file with full content.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "Edit", description: "Replace one unique exact string in a workspace file.", parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] } },
  { name: "ApplyPatch", description: "Apply a unified diff patch inside the workspace.", parameters: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] } },
  { name: "Bash", description: "Run a command as a fixed argv array (never a shell) in the workspace.", parameters: { type: "object", properties: { argv: { type: "array", items: { type: "string" } }, timeoutMs: { type: "number" } }, required: ["argv"] } },
  { name: "Grep", description: "Search file contents with a ripgrep regex; optional glob narrows paths.", parameters: { type: "object", properties: { pattern: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] } },
  { name: "Glob", description: "List workspace-relative files matching a glob pattern.", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
];
