import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAIN = join(ROOT, "packages/facade-cli/dist/main.js");
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("headless CLI (deterministic test provider, explicitly configured)", () => {
  it("run fixes the fixture, inspect shows receipts, recover is clean, analyze never executes", async () => {
    const ws = tempDir("zfacade-cli-ws-");
    cpSync(join(ROOT, "fixtures/repos/failing-test"), ws, { recursive: true });
    const home = tempDir("zfacade-cli-home-");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      provider: { kind: "deterministic-test", deterministicScriptPath: join(ROOT, "fixtures/provider/fix-script.json") },
      grants: [
        { id: "edit-src", tool: "Edit", match: "src/" },
        { id: "bash-test", tool: "Bash", match: "node --test" },
      ],
    }));
    const env = { ...process.env, ZFACADE_HOME: home };
    const r = await run(process.execPath, [MAIN, "run", "--workspace", ws, "--json", "Fix the failing test"], { env });
    const outcome = JSON.parse(r.stdout) as { exitCode: number; status: string; providerLabel: string; runId: string };
    expect(outcome.status).toBe("completed");
    expect(outcome.providerLabel).toBe("deterministic-test");
    expect(readFileSync(join(ws, "src/calc.mjs"), "utf8")).toContain("a + b");

    const ins = await run(process.execPath, [MAIN, "inspect", "--workspace", ws, "--run", outcome.runId, "--json"], { env });
    const inspected = JSON.parse(ins.stdout) as { effects: Array<{ state: string }>; nodes: unknown[]; holds: unknown[] };
    expect(inspected.effects.length).toBe(4);
    expect(inspected.effects.every((e) => e.state === "completed")).toBe(true);
    expect(inspected.holds).toEqual([]);

    const rec = await run(process.execPath, [MAIN, "recover", "--workspace", ws, "--json"], { env });
    expect((JSON.parse(rec.stdout) as { holds: unknown[] }).holds).toEqual([]);

    const ana = await run(process.execPath, [MAIN, "analyze", join(ROOT, "fixtures/workflows/world-run.ts"), "--json"], { env });
    const analyzed = JSON.parse(ana.stdout) as { ok: boolean; execution_authorized: boolean };
    expect(analyzed.ok).toBe(true);
    expect(analyzed.execution_authorized).toBe(false);
  }, 180_000);

  it("without provider config, run fails loudly instead of fabricating a backend", async () => {
    const ws = tempDir("zfacade-cli-ws-");
    const home = tempDir("zfacade-cli-home-");
    await expect(run(process.execPath, [MAIN, "run", "--workspace", ws, "do something"],
      { env: { ...process.env, ZFACADE_HOME: home } })).rejects.toMatchObject({ code: 5 });
  }, 60_000);
});
