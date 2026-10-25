import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_CAPABILITIES } from "@zfacade/contracts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAIN = join(ROOT, "packages/facade-cli/dist/main.js");
const TSC = join(ROOT, "node_modules/typescript/bin/tsc");
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeWorkspace(variant: "stub" | "implemented" | "two-stubs" | "renamed"): string {
  const ws = tempDir("zfacade-bridge-ws-");
  mkdirSync(join(ws, "src")); mkdirSync(join(ws, "test"));
  const bodies = {
    stub: `export function sum(left: number, right: number): number { throw new Error("UNIMPLEMENTED"); }\n`,
    implemented: `export function sum(left: number, right: number): number { return left + right; }\n`,
    "two-stubs": `export function sum(left: number, right: number): number { throw new Error("UNIMPLEMENTED"); }\nexport function product(left: number, right: number): number { throw new Error("UNIMPLEMENTED"); }\n`,
    renamed: `export function sum(alpha: number, beta: number): number { throw new Error("UNIMPLEMENTED"); }\n`,
  };
  writeFileSync(join(ws, "src/math.ts"), bodies[variant]);
  const testBody = variant === "two-stubs"
    ? `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum, product } from "../src/math.ts";\ntest("sum", () => { assert.equal(sum(2, 3), 5); });\ntest("product", () => { assert.equal(product(3, 4), 12); });\n`
    : `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "../src/math.ts";\ntest("sum", () => { assert.equal(sum(20, 22), 42); });\n`;
  writeFileSync(join(ws, "test/math.test.ts"), testBody);
  writeFileSync(join(ws, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, types: ["node"], allowImportingTsExtensions: true }, include: ["src"] }));
  // node types for the fixture typecheck resolve through the repo install.
  mkdirSync(join(ws, "node_modules", "@types"), { recursive: true });
  symlinkSync(join(ROOT, "node_modules/@types/node"), join(ws, "node_modules/@types/node"));
  return ws;
}

class BridgeClient {
  private proc: ChildProcessWithoutNullStreams;
  private serial = 0;
  private buffer = "";
  private readonly lines: string[] = [];
  private waiter: ((line: string) => void) | undefined;
  constructor(home: string) {
    this.proc = spawn(process.execPath, [MAIN, "bridge"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir(), LANG: "en_US.UTF-8" },
    });
    this.proc.stdout.on("data", (d: Buffer) => {
      this.buffer += d.toString("utf8");
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx); this.buffer = this.buffer.slice(idx + 1);
        if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(line); }
        else this.lines.push(line);
      }
    });
  }
  async call(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    this.serial += 1;
    const id = this.serial;
    const packet = JSON.stringify({ protocol: 1, id, method, params }) + "\n";
    if (Buffer.byteLength(packet) > 1_000_000) throw new Error("request too large");
    this.proc.stdin.write(packet);
    const line = await new Promise<string>((resolve, reject) => {
      const queued = this.lines.shift();
      if (queued !== undefined) return resolve(queued);
      const timer = setTimeout(() => reject(new Error(`bridge timeout waiting for ${method}`)), 120_000);
      this.waiter = (l) => { clearTimeout(timer); resolve(l); };
    });
    const answer = JSON.parse(line) as { id: number; protocol: number; result?: Record<string, any>; error?: { code: string } };
    if (answer.id !== id || answer.protocol !== 1) throw new Error("bridge response mismatch");
    if (answer.error) throw new Error(`bridge infrastructure error: ${answer.error.code}`);
    return answer.result!;
  }
  private closedFlag = false;
  async close(): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    try { await this.call("close", {}); } catch { /* process may already be gone */ }
    try { this.proc.stdin.end(); } catch { /* already ended */ }
    this.proc.kill();
  }
}

async function openEpisode(client: BridgeClient, ws: string): Promise<void> {
  const hello = await client.call("hello", { protocol: 1 });
  for (const cap of REQUIRED_CAPABILITIES) expect(hello.capabilities).toContain(cap);
  await client.call("open", {
    workspace: ws,
    task: { task_id: "t1", user_prompt: "Fix math", target_files: ["src/math.ts"] },
    gates: {
      "task-tests": {
        argv: ["node", "--test", "test/math.test.ts"],
        typecheck_argv: ["node", TSC, "--noEmit", "-p", "tsconfig.json"],
        protected_files: ["test/math.test.ts"],
      },
    },
    limits: { max_worker_calls: 8, max_graph_nodes: 64, max_subgraph_expansions: 32, tool_timeout_seconds: 60 },
  });
}

function bridgeTest(name: string, fn: (client: BridgeClient, ws: string) => Promise<void>, variant: "stub" | "implemented" | "two-stubs" | "renamed" = "stub") {
  it(name, async () => {
    const ws = makeWorkspace(variant);
    const home = tempDir("zfacade-bridge-home-");
    const client = new BridgeClient(home);
    cleanups.push(() => { void client.close(); });
    await openEpisode(client, ws);
    await fn(client, ws);
    await client.close();
  }, 240_000);
}

describe("training bridge protocol v1 (real CLI process, tinker-shaped client)", () => {
  bridgeTest("inspect-only workflow completes with verified_green on a passing repo", async (client) => {
    const source = readFileSync(join(ROOT, "fixtures/workflows/inspect-only.ts"), "utf8");
    const result = await client.call("submit_workflow", { ts_code: source });
    expect(result.status).toBe("completed");
    expect(result.receipt.verified_green).toBe(true);
    expect(result.receipt.no_unresolved_holes).toBe(true);
    expect(result.receipt.tests_unchanged).toBe(true);
  }, "implemented");

  bridgeTest("typed code leaf edits one target and passes unchanged tests; stale hash redispatched", async (client, ws) => {
    const source = readFileSync(join(ROOT, "fixtures/workflows/typed-leaf.ts"), "utf8");
    let result = await client.call("submit_workflow", { ts_code: source });
    expect(result.status).toBe("worker_required");
    expect(result.request.kind).toBe("code");
    expect(result.request.target_id).toBe("src/math.ts#sum");
    // Stale hash first: must be rejected back to the worker, never applied.
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "test-worker",
      payload: JSON.stringify({ kind: "code", target_id: "src/math.ts#sum", expected_body_hash: "0".repeat(64), body: "{ return left + right; }" }),
      clean_termination: true,
    });
    expect(result.status).toBe("worker_required");
    expect(readFileSync(join(ws, "src/math.ts"), "utf8")).toContain("UNIMPLEMENTED");
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "test-worker",
      payload: JSON.stringify({ kind: "code", target_id: "src/math.ts#sum", expected_body_hash: result.request.expected_body_hash, body: "{ return left + right; }" }),
      clean_termination: true,
    });
    expect(result.status).toBe("completed");
    expect(readFileSync(join(ws, "src/math.ts"), "utf8")).toContain("return left + right;");
    expect(result.receipt.verified_green).toBe(true);
    expect(result.receipt.tests_unchanged).toBe(true);
    expect(result.receipt.test_receipt_ids.length).toBeGreaterThan(0);
    expect(result.receipt.effect_receipt_ids.length).toBeGreaterThan(0);
  });

  bridgeTest("askData rejects wrong JSON shapes, accepts valid data, and never writes a file", async (client, ws) => {
    const source = readFileSync(join(ROOT, "fixtures/workflows/ask-data.ts"), "utf8");
    const before = readFileSync(join(ws, "src/math.ts"), "utf8");
    let result = await client.call("submit_workflow", { ts_code: source });
    expect(result.status).toBe("worker_required");
    expect(result.request.kind).toBe("data");
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", body: "{ return 42; }" }), clean_termination: true,
    });
    expect(result.status).toBe("worker_required");
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "data", value: { value: "forty-two" } }), clean_termination: true,
    });
    expect(result.status).toBe("worker_required");
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "data", value: { value: 42 } }), clean_termination: true,
    });
    expect(result.status).toBe("completed");
    expect(readFileSync(join(ws, "src/math.ts"), "utf8")).toBe(before);
  }, "implemented");

  bridgeTest("R5: subgraph envelopes fail closed; sequential leaves still complete", async (client, ws) => {
    const source = readFileSync(join(ROOT, "fixtures/workflows/subgraph.ts"), "utf8");
    let result = await client.call("submit_workflow", { ts_code: source });
    expect(result.status).toBe("worker_required");
    const obligations = result.request.obligations as string[];
    expect(obligations.length).toBe(2);
    // Review reproduction: invalid TS + wrong root digest must never be accepted.
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await client.call("resolve_worker", {
        request_id: result.request.request_id, checkpoint: "w",
        payload: JSON.stringify({
          kind: "subgraph", source: "THIS IS NOT VALID TYPESCRIPT !!!", root_digest: "wrong-root",
          children: obligations.map((o) => ({ obligations: [o], scope: ["src/math.ts"], root_digest: "wrong-root" })),
        }), clean_termination: true,
      });
      expect(result.status).toBe("worker_required");
      expect(result.request.obligations).toEqual(obligations);
      expect(JSON.stringify(result.request.diagnostics)).toContain("not supported");
    }
    const bodies: Record<string, string> = {
      "src/math.ts#sum": "{ return left + right; }",
      "src/math.ts#product": "{ return left * right; }",
    };
    for (let guard = 0; guard < 4 && result.status === "worker_required"; guard++) {
      expect(result.request.kind).toBe("code");
      result = await client.call("resolve_worker", {
        request_id: result.request.request_id, checkpoint: "w",
        payload: JSON.stringify({
          kind: "code", target_id: result.request.target_id,
          expected_body_hash: result.request.expected_body_hash,
          body: bodies[result.request.target_id as string],
        }), clean_termination: true,
      });
    }
    expect(result.status).toBe("completed");
    const finalSource = readFileSync(join(ws, "src/math.ts"), "utf8");
    expect(finalSource).toContain("return left + right;");
    expect(finalSource).toContain("return left * right;");
    expect(result.receipt.verified_green).toBe(true);
    expect(result.receipt.max_depth).toBe(1);
  }, "two-stubs");

  bridgeTest("amendment replays unaffected world work and redispatches the changed ask", async (client) => {
    const v1 = readFileSync(join(ROOT, "fixtures/workflows/ask-data.ts"), "utf8");
    let result = await client.call("submit_workflow", { ts_code: v1 });
    expect(result.status).toBe("worker_required");
    const nodeKey = String(result.request.node);
    const siteId = nodeKey.split("@")[0]!;
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "data", value: { value: 42 } }), clean_termination: true,
    });
    expect(result.status).toBe("completed");
    const stale = await client.call("amend_workflow", { hole_id: siteId, revision: 99, updated_ts_code: v1 });
    expect(stale.status).toBe("stale_revision");
    const v2 = v1.replace("sum(20, 22)", "sum(1, 2)");
    result = await client.call("amend_workflow", { hole_id: siteId, revision: 0, updated_ts_code: v2 });
    expect(result.status).toBe("worker_required");
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "data", value: { value: 3 } }), clean_termination: true,
    });
    expect(result.status).toBe("completed");
    expect(result.receipt.reused_nodes).toBeGreaterThan(0);
    expect(result.receipt.verified_green).toBe(true);
  }, "implemented");

  bridgeTest("unknown gate ids and protected-file writes are rejected (acceptance 7)", async (client, ws) => {
    const evil = `await sh.z_verify("rm -rf /");\nreturn 1;`;
    let result = await client.call("submit_workflow", { ts_code: evil });
    expect(result.status).not.toBe("completed");
    expect(result.receipt.verified_green).toBe(false);
    const tamper = [
      `const refs = await sh.z_sig("test/math.test.ts");`,
      `await askCode<(a: number, b: number) => number>("weaken the test", refs);`,
      `return 1;`,
    ].join("\n");
    result = await client.call("submit_workflow", { ts_code: tamper });
    if (result.status === "worker_required") {
      result = await client.call("resolve_worker", {
        request_id: result.request.request_id, checkpoint: "w",
        payload: JSON.stringify({ kind: "code", target_id: result.request.target_id, expected_body_hash: result.request.expected_body_hash, body: "{ return 0; }" }),
        clean_termination: true,
      });
    }
    if (result.status === "worker_required") {
      result = await client.call("cancel", { reason: "test" });
    }
    expect(readFileSync(join(ws, "test/math.test.ts"), "utf8")).toContain("assert.equal(sum(20, 22), 42)");
    expect(result.receipt.verified_green).toBe(false);
    expect(result.receipt.tests_unchanged).toBe(true);
  });

  bridgeTest("cancel stops a parked run and close is idempotent", async (client) => {
    const source = readFileSync(join(ROOT, "fixtures/workflows/typed-leaf.ts"), "utf8");
    let result = await client.call("submit_workflow", { ts_code: source });
    expect(result.status).toBe("worker_required");
    result = await client.call("cancel", { reason: "test" });
    expect(result.status).toBe("cancelled");
    expect(result.receipt.verified_green).toBe(false);
    const closed = await client.call("close", {});
    expect(closed.status).toBe("closed");
  });

  // ---- readiness-review regressions (R1-R7 reproductions) ----

  bridgeTest("R1: errored workflow on a passing workspace is never verified_green", async (client) => {
    const result = await client.call("submit_workflow", { ts_code: `await sh.z_verify("unregistered-gate"); return 1;` });
    expect(result.status).toBe("errored");
    expect(result.receipt.verified_green).toBe(false);
    expect(result.receipt.settlement_status).toBe("errored");
    expect(result.receipt.policy_violation).toBe(true);
    expect(result.receipt.tests_pass).toBe(true); // fresh gates pass; predicate still refuses green
  }, "implemented");

  bridgeTest("R1: cancellation retains pending work in the receipt", async (client) => {
    const source = readFileSync(join(ROOT, "fixtures/workflows/ask-data.ts"), "utf8");
    let result = await client.call("submit_workflow", { ts_code: source });
    expect(result.status).toBe("worker_required");
    result = await client.call("cancel", { reason: "review" });
    expect(result.status).toBe("cancelled");
    expect(result.receipt.verified_green).toBe(false);
    expect(result.receipt.cancelled).toBe(true);
    expect(result.receipt.no_unresolved_holes).toBe(false);
    expect((result.receipt.pending_workers as unknown[]).length).toBeGreaterThan(0);
  }, "implemented");

  bridgeTest("R1: repair followed by an invalid gate call does not earn green", async (client, ws) => {
    const src = [
      `type Sum = (left: number, right: number) => number;`,
      `const refs = await sh.z_sig("src/math.ts");`,
      `await askCode<Sum>("Implement sum", refs);`,
      `await sh.z_verify("task-tests");`,
      `await sh.z_verify("unregistered-gate");`,
      `return 1;`,
    ].join("\n");
    let result = await client.call("submit_workflow", { ts_code: src });
    expect(result.status).toBe("worker_required");
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", target_id: result.request.target_id, expected_body_hash: result.request.expected_body_hash, body: "{ return left + right; }" }),
      clean_termination: true,
    });
    expect(result.status).toBe("errored");
    expect(readFileSync(join(ws, "src/math.ts"), "utf8")).toContain("return left + right;");
    expect(result.receipt.verified_green).toBe(false);
    expect(result.receipt.tests_pass).toBe(true);
  });

  bridgeTest("G5: verify-only workflow earns no progress credit (0 worker dispatches)", async (client) => {
    const result = await client.call("submit_workflow", { ts_code: `await sh.z_verify("task-tests"); return 1;` });
    expect(result.status).toBe("completed");
    expect(result.receipt.worker_calls).toBe(0);
    expect(result.receipt.meaningful_progress).toBe(false);
    expect(result.receipt.verified_green).toBe(false);
    expect(result.receipt.compile_clean).toBe(true);
  });

  bridgeTest("R7: compiler diagnostics are structured objects, never [object Object]", async (client) => {
    const result = await client.call("submit_workflow", { ts_code: `const broken: number = "x"; return broken;` });
    expect(result.status).toBe("compile_error");
    const diags = result.diagnostics as Array<Record<string, unknown>>;
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) {
      expect(typeof d).toBe("object");
      expect(typeof d.code).toBe("string");
      expect(typeof d.message).toBe("string");
      expect(String(d.message)).not.toContain("[object Object]");
    }
    expect(JSON.stringify(diags)).toMatch(/string|number/);
  }, "implemented");

  bridgeTest("R4: incompatible T is rejected at dispatch; nothing is written", async (client, ws) => {
    const before = readFileSync(join(ws, "src/math.ts"), "utf8");
    const src = `const refs = await sh.z_sig("src/math.ts"); await askCode<(text: string) => boolean>("Implement sum", refs); return 1;`;
    const result = await client.call("submit_workflow", { ts_code: src });
    expect(result.status).toBe("errored");
    expect(JSON.stringify(result.diagnostics)).toContain("contract mismatch");
    expect(readFileSync(join(ws, "src/math.ts"), "utf8")).toBe(before);
    expect(result.receipt.verified_green).toBe(false);
  });

  bridgeTest("R4: missing target identity or hash is rejected, exact identity succeeds", async (client) => {
    const source = readFileSync(join(ROOT, "fixtures/workflows/typed-leaf.ts"), "utf8");
    let result = await client.call("submit_workflow", { ts_code: source });
    expect(result.status).toBe("worker_required");
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", body: "{ return left + right; }" }),
      clean_termination: true,
    });
    expect(result.status).toBe("worker_required");
    expect(JSON.stringify(result.request.diagnostics)).toContain("requires target_id and expected_body_hash");
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", target_id: result.request.target_id, expected_body_hash: result.request.expected_body_hash, body: "{ return left + right; }" }),
      clean_termination: true,
    });
    expect(result.status).toBe("completed");
    expect(result.receipt.verified_green).toBe(true);
  });

  bridgeTest("R3: envelope alone suffices — worker uses only request parameters (renamed)", async (client, ws) => {
    const source = readFileSync(join(ROOT, "fixtures/workflows/typed-leaf.ts"), "utf8");
    let result = await client.call("submit_workflow", { ts_code: source });
    expect(result.status).toBe("worker_required");
    const req = result.request;
    expect(String(req.resolved_type)).toContain("number");
    expect(String(req.resolved_type)).not.toBe("Sum");
    expect(String(req.target_declaration)).toContain("alpha");
    expect(req.parameters).toEqual([
      { name: "alpha", type: "number" }, { name: "beta", type: "number" },
    ]);
    expect(String(req.current_body)).toContain("UNIMPLEMENTED");
    expect((req.evidence as unknown[]).length).toBeGreaterThan(0);
    expect(req.task).toBeTruthy();
    // Worker constructs the body exclusively from envelope parameter names.
    const [p0, p1] = (req.parameters as Array<{ name: string }>).map((p) => p.name);
    result = await client.call("resolve_worker", {
      request_id: req.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", target_id: req.target_id, expected_body_hash: req.expected_body_hash, body: `{ return ${p0} + ${p1}; }` }),
      clean_termination: true,
    });
    expect(result.status).toBe("completed");
    expect(result.receipt.verified_green).toBe(true);
    expect(readFileSync(join(ws, "src/math.ts"), "utf8")).toContain("return alpha + beta;");
  }, "renamed");

  bridgeTest("R2: generated code cannot write outside the episode workspace", async (client, ws) => {
    const sentinel = join(ws, "..", `outside-sentinel-${process.pid}.txt`);
    const source = readFileSync(join(ROOT, "fixtures/workflows/typed-leaf.ts"), "utf8");
    let result = await client.call("submit_workflow", { ts_code: source });
    expect(result.status).toBe("worker_required");
    const body = `{ Function("return process")().getBuiltinModule("fs").writeFileSync(${JSON.stringify(sentinel)}, "escape"); return left + right; }`;
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", target_id: result.request.target_id, expected_body_hash: result.request.expected_body_hash, body }),
      clean_termination: true,
    });
    expect(existsSync(sentinel)).toBe(false);
    expect(result.receipt.verified_green).toBe(false);
  });

  bridgeTest("R2: generated code cannot read host credentials through the verifier", async (client) => {
    const source = readFileSync(join(ROOT, "fixtures/workflows/typed-leaf.ts"), "utf8");
    let result = await client.call("submit_workflow", { ts_code: source });
    expect(result.status).toBe("worker_required");
    const body = `{ const fs = Function("return process")().getBuiltinModule("fs"); fs.readFileSync("/Users/mac/zfacade/.env", "utf8"); return left + right; }`;
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", target_id: result.request.target_id, expected_body_hash: result.request.expected_body_hash, body }),
      clean_termination: true,
    });
    // The sandboxed test run must fail (read denied), so no green is possible.
    expect(result.receipt.verified_green).toBe(false);
    expect(result.receipt.tests_pass).toBe(false);
  });

  bridgeTest("R6: amended successor observes gates fresh (fail-to-pass)", async (client) => {
    const v1 = [
      `type Sum=(left:number,right:number)=>number;`,
      `const refs=await sh.z_sig("src/math.ts");`,
      `await askCode<Sum>("first attempt",refs);`,
      `const gate=await sh.z_verify("task-tests");`,
      `if (gate.exit_code !== 0) { throw new Error("GATE_OBSERVATION_FAILURE"); }`,
      `return 1;`,
    ].join("\n");
    let result = await client.call("submit_workflow", { ts_code: v1 });
    expect(result.status).toBe("worker_required");
    const siteId = String(result.request.node).split("@")[0]!;
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", target_id: result.request.target_id, expected_body_hash: result.request.expected_body_hash, body: "{ return 0; }" }),
      clean_termination: true,
    });
    expect(result.status).toBe("errored");
    expect(result.receipt.verified_green).toBe(false);
    result = await client.call("amend_workflow", { hole_id: siteId, revision: 0, updated_ts_code: v1.replace("first attempt", "second attempt") });
    expect(result.status).toBe("worker_required");
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", target_id: result.request.target_id, expected_body_hash: result.request.expected_body_hash, body: "{ return left + right; }" }),
      clean_termination: true,
    });
    // Stale failing z_verify must not decide successor control flow.
    expect(result.status).toBe("completed");
    expect(result.receipt.verified_green).toBe(true);
    expect(result.receipt.reused_nodes).toBeGreaterThan(0); // z_sig replayed
    // Fresh script-level verify (2 receipts) + fresh final gates (2 receipts).
    expect((result.receipt.test_receipt_ids as unknown[]).length).toBeGreaterThanOrEqual(4);
  });

  bridgeTest("R6: pass-to-fail amendment is not rescued by stale passing observations", async (client) => {
    const v1 = [
      `type Sum=(left:number,right:number)=>number;`,
      `const refs=await sh.z_sig("src/math.ts");`,
      `await askCode<Sum>("first attempt",refs);`,
      `const gate=await sh.z_verify("task-tests");`,
      `if (gate.exit_code !== 0) { throw new Error("GATE_OBSERVATION_FAILURE"); }`,
      `return 1;`,
    ].join("\n");
    let result = await client.call("submit_workflow", { ts_code: v1 });
    const siteId = String(result.request.node).split("@")[0]!;
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", target_id: result.request.target_id, expected_body_hash: result.request.expected_body_hash, body: "{ return left + right; }" }),
      clean_termination: true,
    });
    expect(result.status).toBe("completed");
    result = await client.call("amend_workflow", { hole_id: siteId, revision: 0, updated_ts_code: v1.replace("first attempt", "second attempt") });
    expect(result.status).toBe("worker_required");
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", target_id: result.request.target_id, expected_body_hash: result.request.expected_body_hash, body: "{ return 0; }" }),
      clean_termination: true,
    });
    expect(result.status).toBe("errored");
    expect(result.receipt.verified_green).toBe(false);
    expect(result.receipt.tests_pass).toBe(false);
  });

  bridgeTest("R6: independent sibling ask is replayed without repeating its write", async (client, ws) => {
    const v1 = [
      `type Sum=(left:number,right:number)=>number;`,
      `const refs=await sh.z_sig("src/math.ts");`,
      `await askCode<Sum>("implement sum",refs.filter(r=>r.symbol==="sum"));`,
      `await askCode<Sum>("implement product v1",refs.filter(r=>r.symbol==="product"));`,
      `await sh.z_verify("task-tests");`,
      `return 1;`,
    ].join("\n");
    const bodies: Record<string, string> = {
      "src/math.ts#sum": "{ return left + right; }",
      "src/math.ts#product": "{ return left * right; }",
    };
    let result = await client.call("submit_workflow", { ts_code: v1 });
    const sites: string[] = [];
    for (let guard = 0; guard < 4 && result.status === "worker_required"; guard++) {
      sites.push(String(result.request.node).split("@")[0]!);
      result = await client.call("resolve_worker", {
        request_id: result.request.request_id, checkpoint: "w",
        payload: JSON.stringify({ kind: "code", target_id: result.request.target_id, expected_body_hash: result.request.expected_body_hash, body: bodies[result.request.target_id as string] }),
        clean_termination: true,
      });
    }
    expect(result.status).toBe("completed");
    expect(sites.length).toBe(2);
    const productSite = sites[1]!;
    result = await client.call("amend_workflow", {
      hole_id: productSite, revision: 0,
      updated_ts_code: v1.replace("implement product v1", "implement product v2"),
    });
    // Only the changed product ask dispatches; the sum sibling replays.
    expect(result.status).toBe("worker_required");
    expect(result.request.target_id).toBe("src/math.ts#product");
    result = await client.call("resolve_worker", {
      request_id: result.request.request_id, checkpoint: "w",
      payload: JSON.stringify({ kind: "code", target_id: result.request.target_id, expected_body_hash: result.request.expected_body_hash, body: bodies["src/math.ts#product"] }),
      clean_termination: true,
    });
    expect(result.status).toBe("completed");
    expect(result.receipt.verified_green).toBe(true);
    expect(result.receipt.reused_nodes).toBeGreaterThan(0);
    expect(readFileSync(join(ws, "src/math.ts"), "utf8")).toContain("return left + right;");
  }, "two-stubs");
});
