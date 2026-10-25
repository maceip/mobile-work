import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localDeclarations, typecheckFile } from "../src/sh-ops.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("typecheckFile project ambient environment", () => {
  it("honors the nearest tsconfig libs (DOM globals typecheck)", () => {
    const ws = tempDir("zfacade-shops-");
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, lib: ["ES2022", "DOM"], types: [] },
      include: ["src"],
    }));
    const file = join(ws, "src/enc.ts");
    writeFileSync(file, `export function enc(s: string): number { return new TextEncoder().encode(s).byteLength; }\n`);
    expect(typecheckFile(file)).toEqual([]);
  });

  it("falls back to es2022+DOM without a tsconfig", () => {
    const ws = tempDir("zfacade-shops-");
    const file = join(ws, "enc.ts");
    writeFileSync(file, `export function enc(s: string): number { return new TextEncoder().encode(s).byteLength; }\n`);
    expect(typecheckFile(file)).toEqual([]);
  });

  it("grounds module locals and import bindings without leaking bodies", () => {
    const source = [
      `import def, { readFile as rf } from "node:fs";`,
      `import * as path from "node:path";`,
      `const HISTORY_COMMAND_CATALOG: Record<string, number> = { alpha: 1, beta: 2 };`,
      `let counter = makeCounter(1);`,
      `interface Opts { n?: number }`,
      `enum Mode { On, Off }`,
      `class Box { value = 0; get(): number { return SECRET_BODY_TOKEN; } }`,
      `function helper(x: number, w: number = 80): number { return x + SECRET_BODY_TOKEN; }`,
      `export function entry(k: string): number { throw new Error("stub"); }`,
    ].join("\n");
    const decls = localDeclarations(source, "m.ts");
    const byName = new Map(decls.map((d) => [d.name, d]));
    expect(byName.get("HISTORY_COMMAND_CATALOG")?.kind).toBe("variable");
    expect(byName.get("HISTORY_COMMAND_CATALOG")?.signature).toContain("Record<string, number>");
    expect(byName.get("counter")?.signature).toContain("call makeCounter");
    expect(byName.get("rf")).toMatchObject({ kind: "import", imported_from: "node:fs", imported_name: "readFile" });
    expect(byName.get("def")?.imported_name).toBe("default");
    expect(byName.get("path")?.imported_name).toBe("*");
    expect(byName.get("Opts")?.kind).toBe("interface");
    expect(byName.get("Mode")?.signature).toContain("On, Off");
    expect(byName.get("Box")?.signature).toContain("get");
    expect(byName.get("helper")?.signature).toContain("w: number = 80");
    expect(byName.get("entry")?.exported).toBe(true);
    expect(JSON.stringify(decls)).not.toContain("SECRET_BODY_TOKEN");
  });

  it("still reports real type errors in the file", () => {
    const ws = tempDir("zfacade-shops-");
    const file = join(ws, "bad.ts");
    writeFileSync(file, `export function bad(s: string): number { return s; }\n`);
    expect(typecheckFile(file).join(" ")).toContain("TS2322");
  });
});
