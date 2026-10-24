import * as ts from "typescript";
import { sha256Hex } from "@zfacade/contracts";
import { ToolDeniedError } from "./tools.js";

export interface SigTarget {
  name: string;
  signature: string;
  start: number;
  end: number;
  bodyHash: string;
  signatureSource: string;
  parameters: Array<{ name: string; type: string; optional?: boolean; rest?: boolean }>;
  returnType: string;
  bodyText: string;
}

/** Port of zfacade-tinker zcode_patch/compiler.mjs targets(): exported top-level functions only. */
export function sigTargets(source: string, filename = "source.ts"): SigTarget[] {
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const result: SigTarget[] = [];
  for (const node of sf.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body || !node.type) continue;
    if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (node.typeParameters?.length || node.asteriskToken) continue;
    if (node.parameters.some((p) => !p.type || !ts.isIdentifier(p.name))) continue;
    const signature = `(${node.parameters.map((p) => `${p.dotDotDotToken ? "..." : ""}${p.name.getText(sf)}${p.questionToken ? "?" : ""}: ${p.type!.getText(sf)}`).join(", ")}) => ${node.type.getText(sf)}`;
    result.push({
      name: node.name.text, signature,
      start: node.body.getStart(sf), end: node.body.getEnd(),
      bodyHash: sha256Hex(node.body.getText(sf)),
      signatureSource: source.slice(node.getStart(sf), node.body.getStart(sf)).trim(),
      parameters: node.parameters.map((p) => ({
        name: p.name.getText(sf), type: p.type!.getText(sf),
        ...(p.questionToken ? { optional: true } : {}),
        ...(p.dotDotDotToken ? { rest: true } : {}),
      })),
      returnType: node.type.getText(sf),
      bodyText: node.body.getText(sf),
    });
  }
  return result;
}

/** Port of compiler.mjs spliceBody(): checked body-offset replacement, never substring guessing. */
export function spliceBody(source: string, filename: string, name: string, expectedHash: string, body: string): string {
  const target = sigTargets(source, filename).find((t) => t.name === name);
  if (!target || target.bodyHash !== expectedHash) {
    throw new ToolDeniedError("Target missing or changed since dispatch");
  }
  const parsed = ts.createSourceFile("body.ts", `function __hole() ${body}`, ts.ScriptTarget.Latest, true);
  const first = parsed.statements[0];
  const parseDiags = (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (parseDiags.length > 0 || parsed.statements.length !== 1 || !first || !ts.isFunctionDeclaration(first)
    || !first.body || first.body.getText(parsed) !== body.trim()) {
    throw new ToolDeniedError("Worker must return exactly one function body");
  }
  return source.slice(0, target.start) + body + source.slice(target.end);
}

/** Import declaration texts of a source file (needed imports for worker envelopes). */
export function fileImports(source: string, filename = "source.ts"): string[] {
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  return sf.statements.filter(ts.isImportDeclaration).map((d) => d.getText(sf).trim());
}

/**
 * R4: check the stated askCode<T> contract against the bound target's
 * project-resolved type, in both directions, with the real checker. The
 * target remains callable exactly where T is expected and vice versa.
 * Returns problem diagnostics (empty = compatible).
 */
export function checkContract(input: {
  source: string; filename: string; symbol: string; typeText: string; typeDefs?: string;
}): string[] {
  const assertions = [
    input.typeDefs ? `${input.typeDefs}\n` : "",
    `type __ZfT = ${input.typeText};\n`,
    `const __zfForward: __ZfT = ${input.symbol};\n`,
    `const __zfBack: typeof ${input.symbol} = (null as unknown as __ZfT);\n`,
    `void __zfForward; void __zfBack;\n`,
  ].join("");
  const virtual = `/virtual/${input.filename}`;
  const combined = input.source + "\n" + assertions;
  const assertOffset = input.source.length + 1 + (input.typeDefs ? input.typeDefs.length + 1 : 0);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true,
    types: [], lib: ["lib.es2022.d.ts"], allowImportingTsExtensions: true,
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  host.readFile = (f) => (f === virtual ? combined : originalRead(f));
  host.fileExists = (f) => f === virtual || originalExists(f);
  const originalGet = host.getSourceFile.bind(host);
  host.getSourceFile = (f, v, ...rest) =>
    f === virtual ? ts.createSourceFile(f, combined, v, true) : originalGet(f, v, ...rest);
  const program = ts.createProgram([virtual], options, host);
  return ts.getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === virtual && (d.start ?? 0) >= assertOffset)
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

/**
 * Typecheck one workspace file in a real program (module context), returning
 * diagnostics as text. Used after a code splice before the write is admitted.
 */
export function typecheckFile(absPath: string, sourceOverride?: string): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true,
    types: [], lib: ["lib.es2022.d.ts"], allowImportingTsExtensions: true,
  };
  const host = ts.createCompilerHost(options);
  if (sourceOverride !== undefined) {
    const originalRead = host.readFile.bind(host);
    host.readFile = (f) => (f === absPath ? sourceOverride : originalRead(f));
    const originalGet = host.getSourceFile.bind(host);
    host.getSourceFile = (f, v, ...rest) =>
      f === absPath ? ts.createSourceFile(f, sourceOverride, v, true) : originalGet(f, v, ...rest);
  }
  const program = ts.createProgram([absPath], options, host);
  return ts.getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === absPath)
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}
