import { describe, expect, it } from "vitest";
import { auditTraining, transformTraining } from "../src/bridge-transform.js";
import { prepareWorkflow } from "@zfacade/agent";

describe("training facade audit (bridge acceptance 4)", () => {
  it("rejects nested any/unknown in T and missing type arguments", () => {
    expect(auditTraining(`const x = await askData<{ nested: { v: any } }>("s", []);`).strictClean).toBe(false);
    expect(auditTraining(`const x = await askData<unknown>("s", []);`).strictClean).toBe(false);
    expect(auditTraining(`const x = await askData("s", []);`).strictClean).toBe(false);
    expect(auditTraining(`interface A { v: number }\nconst x = await askData<A>("s", []);`).strictClean).toBe(true);
  });
  it("accepts Promise/recursive authored types without stack overflow", () => {
    expect(auditTraining(`type F = (x: Promise<{ next: Promise<string> }>) => Promise<number>;\nconst x = await askData<F>("s", []);`).strictClean).toBe(true);
    expect(auditTraining(`interface N { next: N | null }\ntype G = (n: N) => Promise<{ value: N }>;\nconst y = await askCode<G>("s", []);`).strictClean).toBe(true);
    expect(auditTraining(`type H = (x: Set<number>) => Map<string, number[]>;\nconst z = await askCode<H>("s", []);`).strictClean).toBe(true);
  });
  it("rejects shadowed facade bindings", () => {
    const src = `function askData<T>(s: string, r: unknown[]): Promise<T> { throw new Error("x"); }\nconst y = await askData<number>("s", []);`;
    const audit = auditTraining(src);
    expect(audit.diagnostics.some((d) => d.code === "SHADOWED_FACADE")).toBe(true);
  });
  it("transformed output compiles under the production compiler", () => {
    const src = `type Sum = (a: number, b: number) => number;\nconst refs = await sh.z_sig("src/math.ts");\nawait askCode<Sum>("impl", refs);\nreturn 1;`;
    const prepared = prepareWorkflow(transformTraining(src));
    expect(prepared.ok, JSON.stringify(prepared.diagnostics)).toBe(true);
  });
});
