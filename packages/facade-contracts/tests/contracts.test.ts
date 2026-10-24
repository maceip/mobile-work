import { describe, expect, it } from "vitest";
import {
  canonicalJson, digestOf, invalidatedNodes, isTerminalSuccess, operationKey,
  validateConfig, validateSubgraph,
} from "../src/index.js";

describe("canonical hashing", () => {
  it("is key-order independent and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: 2 } })).toBe('{"a":{"c":2},"b":1}');
    expect(digestOf({ x: [1, 2] })).toBe(digestOf({ x: [1, 2] }));
    expect(digestOf({ x: 1 })).not.toBe(digestOf({ x: 2 }));
  });
  it("operation keys bind revision, site, ordinals, and input digest", () => {
    const base = { runRevision: "r1", siteId: "ask#1", ordinal: 1, toolOrdinal: 0, inputDigest: "d" };
    expect(operationKey(base)).toBe(operationKey({ ...base }));
    expect(operationKey(base)).not.toBe(operationKey({ ...base, toolOrdinal: 1 }));
    expect(operationKey(base)).not.toBe(operationKey({ ...base, inputDigest: "e" }));
  });
});

describe("validateSubgraph (tinker contract port)", () => {
  const parent = { obligations: ["a", "b"], scope: ["s1"], root_digest: "r" };
  it("accepts a covering strict decomposition", () => {
    expect(() => validateSubgraph(parent, [
      { obligations: ["a"], scope: ["s1"], root_digest: "r" },
      { obligations: ["b"], scope: [], root_digest: "r" },
    ])).not.toThrow();
  });
  it("rejects dropped, duplicated, widened, and re-anchored decompositions", () => {
    expect(() => validateSubgraph(parent, [{ obligations: ["a"], scope: [], root_digest: "r" }])).toThrow(/drops/);
    expect(() => validateSubgraph(parent, [
      { obligations: ["a", "b"], scope: [], root_digest: "r" },
    ])).toThrow(/strict subset/);
    expect(() => validateSubgraph(parent, [
      { obligations: ["a"], scope: ["evil"], root_digest: "r" },
      { obligations: ["b"], scope: [], root_digest: "r" },
    ])).toThrow(/scope/);
    expect(() => validateSubgraph(parent, [
      { obligations: ["a"], scope: [], root_digest: "other" },
      { obligations: ["b"], scope: [], root_digest: "r" },
    ])).toThrow(/scope/);
  });
});

describe("invalidatedNodes (tinker contract port)", () => {
  it("computes transitive dependents and rejects cycles", () => {
    const nodes = [
      { id: "a", deps: [] }, { id: "b", deps: ["a"] },
      { id: "c", deps: ["b"] }, { id: "d", deps: [] },
    ];
    expect([...invalidatedNodes(nodes, new Set(["a"]))].sort()).toEqual(["a", "b", "c"]);
    expect(() => invalidatedNodes([{ id: "x", deps: ["x"] }], new Set(["x"]))).toThrow(/cycle/);
  });
});

describe("validateConfig", () => {
  it("keeps openai-compatible on loopback and rejects remote hosts", () => {
    expect(() => validateConfig({ provider: { kind: "openai-compatible", baseUrl: "https://api.example.com", modelId: "m" } }))
      .toThrow(/loopback/);
    expect(validateConfig({ provider: { kind: "openai-compatible", baseUrl: "http://127.0.0.1:18080/v1", modelId: "m" } }))
      .toBeTruthy();
  });

  it("allows hosted OpenAI only for kind openai", () => {
    expect(validateConfig({
      provider: { kind: "openai", modelId: "gpt-4.1-mini", apiKeyEnv: "OPENAI_API_KEY" },
    })).toBeTruthy();
    expect(validateConfig({
      provider: { kind: "openai", baseUrl: "https://api.openai.com/v1", modelId: "gpt-4.1" },
    })).toBeTruthy();
    expect(() => validateConfig({ provider: { kind: "openai", modelId: "m", baseUrl: "https://evil.example.com" } }))
      .toThrow(/api\.openai\.com|loopback/);
    expect(() => validateConfig({ provider: { kind: "openai" } })).toThrow(/modelId/);
  });

  it("fails closed on malformed grants", () => {
    expect(() => validateConfig({ grants: [{ id: "", tool: "Bash", match: "x" }] })).toThrow(/invalid grant/);
  });
});

describe("isTerminalSuccess (R1 predicate)", () => {
  const clean = {
    compile_clean: true, typecheck_pass: true, tests_pass: true, tests_unchanged: true,
    no_unresolved_holes: true, policy_violation: false, test_tampering: false,
    pending_effect_ids: [] as string[], held_effect_ids: [] as string[], denied_effect_ids: [] as string[],
  };
  it("only completed, fully-resolved settlements succeed", () => {
    expect(isTerminalSuccess("completed", clean)).toBe(true);
    for (const status of ["errored", "stopped", "cancelled", "timeout", "unknown"]) {
      expect(isTerminalSuccess(status, clean), status).toBe(false);
    }
    expect(isTerminalSuccess("completed", { ...clean, pending_effect_ids: ["op1"] })).toBe(false);
    expect(isTerminalSuccess("completed", { ...clean, held_effect_ids: ["op1"] })).toBe(false);
    expect(isTerminalSuccess("completed", { ...clean, denied_effect_ids: ["op1"] })).toBe(false);
    expect(isTerminalSuccess("completed", { ...clean, policy_violation: true })).toBe(false);
    expect(isTerminalSuccess("completed", { ...clean, tests_pass: false })).toBe(false);
  });
});
