import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEpisodeSandbox, destroySandbox, type SandboxSpec } from "../src/sandbox.js";
import { runArgv } from "../src/tools.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function setup(): { ws: string; spec: SandboxSpec } {
  const ws = mkdtempSync(join(tmpdir(), "zfacade-sbx-test-ws-"));
  cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
  const spec = createEpisodeSandbox(ws);
  cleanups.push(() => destroySandbox(spec));
  return { ws, spec };
}

describe("episode seatbelt sandbox (R2)", () => {
  it("allows workspace work and denies outside writes, network, and descendants' escapes", async () => {
    const { ws, spec } = setup();
    const inside = await runArgv([process.execPath, "-e", `require("fs").writeFileSync("ok.txt","x")`], ws, 20_000, undefined, spec);
    expect(inside.exitCode).toBe(0);
    expect(readFileSync(join(ws, "ok.txt"), "utf8")).toBe("x");

    const outsidePath = join(ws, "..", `sbx-escape-${process.pid}.txt`);
    const outside = await runArgv([process.execPath, "-e",
      `require("fs").writeFileSync(${JSON.stringify(outsidePath)}, "x")`], ws, 20_000, undefined, spec);
    expect(outside.exitCode).not.toBe(0);
    expect(existsSync(outsidePath)).toBe(false);

    const descendant = await runArgv([process.execPath, "-e",
      `require("child_process").execFileSync(process.execPath, ["-e", 'require("fs").writeFileSync(${JSON.stringify(JSON.stringify(outsidePath))}, "x")'])`],
    ws, 20_000, undefined, spec);
    expect(descendant.exitCode).not.toBe(0);
    expect(existsSync(outsidePath)).toBe(false);

    const net = await runArgv([process.execPath, "-e",
      `const s = require("net").connect(80, "127.0.0.1"); s.on("connect", () => process.exit(0)); s.on("error", () => process.exit(3)); setTimeout(() => process.exit(4), 5000);`],
    ws, 20_000, undefined, spec);
    expect(net.exitCode).toBe(3);
  }, 120_000);

  it("bounds runaway processes with timeout + process-group kill", async () => {
    const { ws, spec } = setup();
    const started = Date.now();
    const r = await runArgv([process.execPath, "-e", `setTimeout(() => {}, 60000)`], ws, 400, undefined, spec);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);
});
