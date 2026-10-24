import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkspaceStore } from "@zfacade/core";
import {
  BoundedDriver, CrashSimulationError, DeterministicProvider, HoldError,
  SKELETON_SOURCE, ToolExecutor, executeRun, prepareWorkflow, runArgv,
} from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures");
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixtureWorkspace(): string {
  const ws = tempDir("zfacade-agent-ws-");
  cpSync(join(FIXTURES, "repos/failing-test"), ws, { recursive: true });
  return ws;
}

const GRANTS = [
  { id: "edit-src", tool: "Edit" as const, match: "src/" },
  { id: "bash-test", tool: "Bash" as const, match: "node --test" },
];

describe("trusted skeleton with deterministic test provider (labeled double)", () => {
  it("fixes the failing test through engine-owned asks with durable receipts", async () => {
    const ws = fixtureWorkspace();
    const home = tempDir("zfacade-agent-home-");
    const store = openWorkspaceStore(ws, { env: { ZFACADE_HOME: home } });
    cleanups.push(() => store.release());
    const prepared = prepareWorkflow(SKELETON_SOURCE);
    expect(prepared.ok, JSON.stringify(prepared.diagnostics)).toBe(true);
    const driver = new BoundedDriver({
      store, runId: "run-fix-1", runRevision: "run-fix-1#1", mode: "provider",
      provider: DeterministicProvider.fromFile(join(FIXTURES, "provider/fix-script.json")),
      permission: { workspaceRoot: ws, cwd: ws, grants: GRANTS },
    });
    const settlement = await executeRun({
      store, runId: "run-fix-1", scriptText: SKELETON_SOURCE, prepared, driver,
      args: { task: "Fix the failing test in test/calc.test.mjs" }, timeoutMs: 60_000,
    });
    expect(settlement.status).toBe("completed");
    if (settlement.status === "completed") {
      const artifact = settlement.artifact as { done: boolean; providerLabel: string };
      expect(artifact.done).toBe(true);
      expect(artifact.providerLabel).toBe("deterministic-test");
    }
    // Real file effect + independently rerun test process.
    expect(readFileSync(join(ws, "src/calc.mjs"), "utf8")).toContain("return a + b;");
    const verify = await runArgv(["node", "--test", "test/calc.test.mjs"], ws, 60_000);
    expect(verify.exitCode).toBe(0);
    // Engine ownership: every model step is an ask node; tools have completed receipts.
    const asks = store.journal.listNodes("run-fix-1", { kinds: ["ask"], withResult: true });
    expect(asks.length).toBeGreaterThanOrEqual(4);
    expect(asks.every((n) => n.status === "completed")).toBe(true);
    const effects = store.effects.repo.listByRun("run-fix-1");
    expect(effects.map((e) => e.toolName)).toEqual(["Read", "Read", "Edit", "Bash"]);
    expect(effects.every((e) => e.state === "completed")).toBe(true);
    expect(effects[2]?.preHash).toBeTruthy();
    expect(effects[2]?.postHash).not.toBe(effects[2]?.preHash);
  }, 120_000);

  it("without grants, Edit becomes a durable pending question and writes nothing", async () => {
    const ws = fixtureWorkspace();
    const home = tempDir("zfacade-agent-home-");
    const store = openWorkspaceStore(ws, { env: { ZFACADE_HOME: home } });
    cleanups.push(() => store.release());
    const tools = new ToolExecutor(store);
    await expect(tools.execute("Edit", { path: "src/calc.mjs", old: "a - b", new: "a + b" }, {
      runId: "r", runRevision: "r#1", siteId: "ask#1", ordinal: 1, toolOrdinal: 0,
      permission: { workspaceRoot: ws, cwd: ws, grants: [] },
    })).rejects.toThrow(/pending human decision/);
    expect(readFileSync(join(ws, "src/calc.mjs"), "utf8")).toContain("a - b");
    const pending = store.questions.pendingByRun("r");
    expect(pending.length).toBe(1);
    expect(pending[0]?.kind).toBe("permission");
  });

  it("crash after dispatch leaves a dispatched receipt that recovery holds", async () => {
    const ws = fixtureWorkspace();
    const home = tempDir("zfacade-agent-home-");
    const env = { ZFACADE_HOME: home };
    const store = openWorkspaceStore(ws, {
      env,
      effectHooks: {
        afterEffect: (rec) => { if (rec.toolName === "Edit") throw new CrashSimulationError(); },
      },
    });
    const tools = new ToolExecutor(store);
    const ctx = {
      runId: "r", runRevision: "r#1", siteId: "ask#1", ordinal: 1, toolOrdinal: 0,
      permission: { workspaceRoot: ws, cwd: ws, grants: GRANTS },
    };
    await expect(tools.execute("Edit", { path: "src/calc.mjs", old: "return a - b;", new: "return a + b;" }, ctx))
      .rejects.toThrow(/simulated crash/);
    store.release();
    const reopened = openWorkspaceStore(ws, { env });
    cleanups.push(() => reopened.release());
    const held = reopened.effects.recoverScan();
    expect(held.length).toBe(1);
    expect(held[0]?.state).toBe("outcome_unknown");
    const tools2 = new ToolExecutor(reopened);
    await expect(tools2.execute("Edit", { path: "src/calc.mjs", old: "return a - b;", new: "return a + b;" }, ctx))
      .rejects.toBeInstanceOf(HoldError);
    // Explicit reconciliation: file bytes prove the effect landed (post-hash evidence).
    expect(readFileSync(join(ws, "src/calc.mjs"), "utf8")).toContain("return a + b;");
    const reconciled = reopened.effects.reconcile(held[0]!.operationId, "mark-completed", { verifiedContent: true });
    expect(reconciled.state).toBe("completed");
  });
});
