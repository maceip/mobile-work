import type { Grant, PermissionDecision, ToolName } from "@zfacade/contracts";
import { READONLY_TOOLS } from "@zfacade/contracts";
import { assertSafeRelative, resolveInside } from "./paths.js";

export interface PermissionContext {
  workspaceRoot: string;
  cwd: string;
  grants: Grant[];
  /** Bridge episode authority: writable source targets (workspace-relative). */
  writeAllowlist?: string[];
  /** Files that must never be written (bridge protected test files). */
  protectedFiles?: string[];
  /** Bridge episode authority: pinned gate argv allowed for Bash/world.run. */
  pinnedArgv?: string[][];
}

export interface ToolRequest {
  tool: ToolName | "world.run";
  input: Record<string, unknown>;
}

const READONLY_BASH = new Set(["ls", "cat", "pwd", "echo", "printf", "true", "false", "test", "wc", "head", "tail", "file", "stat", "which", "rg", "grep", "git"]);
const READONLY_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files"]);

export function classifyBash(argv: string[]): "readonly" | "mutating" | "unknown" {
  const cmd = argv[0];
  if (!cmd) return "unknown";
  const base = cmd.split("/").pop() ?? cmd;
  if (!READONLY_BASH.has(base)) return "unknown";
  if (base === "git") return READONLY_GIT.has(argv[1] ?? "") ? "readonly" : "unknown";
  if (argv.some((a) => a === ">" || a === ">>" || a.startsWith(">"))) return "unknown";
  return "readonly";
}

function argvOf(req: ToolRequest): string[] | undefined {
  if (req.tool === "Bash") {
    const a = req.input.argv;
    return Array.isArray(a) && a.every((x) => typeof x === "string") ? (a as string[]) : undefined;
  }
  if (req.tool === "world.run") {
    const direct = req.input.argv;
    if (Array.isArray(direct) && direct.every((x) => typeof x === "string")) return direct as string[];
    const cmd = req.input.cmd; const args = req.input.args;
    if (typeof cmd === "string" && (args === undefined || (Array.isArray(args) && args.every((x) => typeof x === "string")))) {
      return [cmd, ...((args as string[] | undefined) ?? [])];
    }
  }
  return undefined;
}

function pathOf(req: ToolRequest): string | undefined {
  const p = req.input.path;
  return typeof p === "string" ? p : undefined;
}

export class PermissionService {
  decide(req: ToolRequest, ctx: PermissionContext): PermissionDecision {
    const protectedSet = new Set(ctx.protectedFiles ?? []);
    if (req.tool === "Bash" || req.tool === "world.run") {
      const argv = argvOf(req);
      if (!argv || argv.length === 0) return { kind: "deny", reason: "command requires a non-empty argv array (shell strings are not accepted)" };
      const joined = argv.join(" ");
      for (const pinned of ctx.pinnedArgv ?? []) {
        if (pinned.length === argv.length && pinned.every((v, i) => v === argv[i])) {
          return { kind: "allow", grantId: "episode-pinned-gate", reason: `pinned gate command: ${joined}` };
        }
      }
      for (const g of ctx.grants) {
        if (g.tool !== req.tool) continue;
        if (g.cwd !== undefined && g.cwd !== ctx.cwd) continue;
        if (joined === g.match || joined.startsWith(g.match + " ")) {
          return { kind: "allow", grantId: g.id, reason: `grant ${g.id} matches command prefix` };
        }
      }
      return { kind: "ask", reason: `no grant for command: ${joined}` };
    }
    const rel = pathOf(req);
    if (req.tool === "Grep") {
      const pattern = req.input.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) return { kind: "deny", reason: "Grep requires a pattern" };
      return { kind: "allow", grantId: "builtin-readonly", reason: "readonly search inside workspace" };
    }
    if (req.tool === "Glob") {
      const pattern = req.input.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) return { kind: "deny", reason: "Glob requires a pattern" };
      if (pattern.includes("..")) return { kind: "deny", reason: "Glob pattern escapes workspace" };
      return { kind: "allow", grantId: "builtin-readonly", reason: "readonly glob inside workspace" };
    }
    if (rel === undefined) return { kind: "deny", reason: `${req.tool} requires a workspace-relative path` };
    try {
      assertSafeRelative(rel);
      resolveInside(ctx.workspaceRoot, rel);
    } catch (e) {
      return { kind: "deny", reason: e instanceof Error ? e.message : String(e) };
    }
    if (READONLY_TOOLS.has(req.tool)) {
      return { kind: "allow", grantId: "builtin-readonly", reason: `readonly ${req.tool} inside workspace` };
    }
    if (protectedSet.has(rel)) {
      return { kind: "deny", reason: `protected file must not be modified: ${rel}` };
    }
    if (ctx.writeAllowlist !== undefined) {
      if (ctx.writeAllowlist.includes(rel)) {
        return { kind: "allow", grantId: "episode-target", reason: `episode write target: ${rel}` };
      }
      return { kind: "deny", reason: `write target outside episode allowlist: ${rel}` };
    }
    for (const g of ctx.grants) {
      if (g.tool !== req.tool) continue;
      if (g.cwd !== undefined && g.cwd !== ctx.cwd) continue;
      if (rel === g.match || rel.startsWith(g.match.replace(/\/?$/, "/"))) {
        return { kind: "allow", grantId: g.id, reason: `grant ${g.id} matches path prefix` };
      }
    }
    return { kind: "ask", reason: `no grant for ${req.tool} on ${rel}` };
  }
}
