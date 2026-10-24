import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkspaceStore, PermissionService, classifyBash } from "../src/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "zfacade-ws-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function tempHome(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "zfacade-home-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { ZFACADE_HOME: dir };
}

describe("EffectService state machine and recovery", () => {
  it("admits idempotently, settles once, and rejects duplicate settlement", () => {
    const ws = tempWorkspace();
    const store = openWorkspaceStore(ws, { env: tempHome() });
    cleanups.push(() => store.release());
    const intent = { runId: "r1", runRevision: "r1#1", siteId: "ask#1", ordinal: 1, toolOrdinal: 0, toolName: "Edit", input: { path: "a.txt" }, cwd: ws };
    const a = store.effects.admit(intent);
    const b = store.effects.admit(intent);
    expect(b.operationId).toBe(a.operationId);
    store.effects.authorize(a.operationId, { grantId: "g1" });
    store.effects.markDispatched(a.operationId);
    expect(store.effects.settleCompleted(a.operationId, { ok: true }).state).toBe("completed");
    expect(() => store.effects.settleCompleted(a.operationId, { ok: true })).toThrow(/first receipt wins/);
  });

  it("holds dispatched mutations as outcome_unknown on recovery; reads stay retryable", () => {
    const ws = tempWorkspace();
    const env = tempHome();
    const store = openWorkspaceStore(ws, { env });
    const edit = store.effects.admit({ runId: "r1", runRevision: "r1#1", siteId: "ask#1", ordinal: 1, toolOrdinal: 0, toolName: "Bash", input: { argv: ["make"] }, cwd: ws });
    store.effects.authorize(edit.operationId, {});
    store.effects.markDispatched(edit.operationId);
    const read = store.effects.admit({ runId: "r1", runRevision: "r1#1", siteId: "ask#1", ordinal: 1, toolOrdinal: 1, toolName: "Read", input: { path: "x" }, cwd: ws });
    store.effects.authorize(read.operationId, {});
    store.effects.markDispatched(read.operationId);
    store.release();
    const reopened = openWorkspaceStore(ws, { env });
    cleanups.push(() => reopened.release());
    const held = reopened.effects.recoverScan();
    expect(held.map((h) => h.operationId)).toEqual([edit.operationId]);
    expect(reopened.effects.repo.get(read.operationId)?.state).toBe("dispatched");
    expect(reopened.effects.prepareRetry(reopened.effects.repo.get(read.operationId)!).state).toBe("authorized");
    const retried = reopened.effects.reconcile(edit.operationId, "retry", { checked: true });
    expect(retried.state).toBe("authorized");
  });
});

describe("PermissionService (D6 headless defaults)", () => {
  const svc = new PermissionService();
  it("allows readonly tools inside the workspace and gates writes/bash on grants", () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, "a.txt"), "hi");
    const ctx = { workspaceRoot: ws, cwd: ws, grants: [] };
    expect(svc.decide({ tool: "Read", input: { path: "a.txt" } }, ctx).kind).toBe("allow");
    expect(svc.decide({ tool: "Edit", input: { path: "a.txt" } }, ctx).kind).toBe("ask");
    expect(svc.decide({ tool: "Bash", input: { argv: ["ls"] } }, ctx).kind).toBe("ask");
    const granted = { ...ctx, grants: [{ id: "g", tool: "Bash" as const, match: "node --test" }] };
    expect(svc.decide({ tool: "Bash", input: { argv: ["node", "--test", "x"] } }, granted).kind).toBe("allow");
    expect(svc.decide({ tool: "Bash", input: { argv: ["node", "--test-evil"] } }, granted).kind).toBe("ask");
  });

  it("denies traversal, symlink escapes, protected files, and off-allowlist writes", () => {
    const ws = tempWorkspace();
    const outside = tempWorkspace();
    writeFileSync(join(outside, "secret.txt"), "s");
    mkdirSync(join(ws, "src"));
    symlinkSync(outside, join(ws, "escape"));
    const ctx = { workspaceRoot: ws, cwd: ws, grants: [], writeAllowlist: ["src/a.ts"], protectedFiles: ["tests/t.ts"] };
    expect(svc.decide({ tool: "Read", input: { path: "../etc/passwd" } }, ctx).kind).toBe("deny");
    expect(svc.decide({ tool: "Read", input: { path: "escape/secret.txt" } }, ctx).kind).toBe("deny");
    expect(svc.decide({ tool: "Write", input: { path: "src/a.ts" } }, ctx).kind).toBe("allow");
    expect(svc.decide({ tool: "Write", input: { path: "src/b.ts" } }, ctx).kind).toBe("deny");
    expect(svc.decide({ tool: "Write", input: { path: "tests/t.ts" } }, ctx).kind).toBe("deny");
  });

  it("classifies the readonly bash family without treating classification as authorization", () => {
    expect(classifyBash(["git", "status"])).toBe("readonly");
    expect(classifyBash(["git", "push"])).toBe("unknown");
    expect(classifyBash(["rm", "-rf", "."])).toBe("unknown");
  });
});
