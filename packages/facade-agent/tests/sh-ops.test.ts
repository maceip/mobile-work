import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { typecheckFile } from "../src/sh-ops.js";

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

  it("still reports real type errors in the file", () => {
    const ws = tempDir("zfacade-shops-");
    const file = join(ws, "bad.ts");
    writeFileSync(file, `export function bad(s: string): number { return s; }\n`);
    expect(typecheckFile(file).join(" ")).toContain("TS2322");
  });
});
