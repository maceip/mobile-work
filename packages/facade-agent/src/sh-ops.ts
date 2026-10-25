import { dirname } from "node:path";
import * as ts from "typescript";
import { sha256Hex, type LocalDeclaration } from "@zfacade/contracts";
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
    // A parameter with an initializer is optional in the call signature;
    // omitting '?' makes the rendered type fail two-way binding checks.
    const signature = `(${node.parameters.map((p) => `${p.dotDotDotToken ? "..." : ""}${p.name.getText(sf)}${p.questionToken || p.initializer ? "?" : ""}: ${p.type!.getText(sf)}`).join(", ")}) => ${node.type.getText(sf)}`;
    result.push({
      name: node.name.text, signature,
      start: node.body.getStart(sf), end: node.body.getEnd(),
      bodyHash: sha256Hex(node.body.getText(sf)),
      signatureSource: source.slice(node.getStart(sf), node.body.getStart(sf)).trim(),
      parameters: node.parameters.map((p) => ({
        name: p.name.getText(sf), type: p.type!.getText(sf),
        ...(p.questionToken || p.initializer ? { optional: true } : {}),
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

function boundedText(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

function describeInitializer(init: ts.Expression, sf: ts.SourceFile): string {
  if (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) return describeInitializer(init.expression, sf);
  if (ts.isObjectLiteralExpression(init)) {
    const keys = init.properties.map((p) => p.name?.getText(sf) ?? "?");
    const shown = keys.slice(0, 8).join(", ");
    return `object {keys: ${shown}${keys.length > 8 ? ` (+${keys.length - 8} more)` : ""}}`;
  }
  if (ts.isArrayLiteralExpression(init)) return `array (${init.elements.length} elements)`;
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return "function";
  if (ts.isCallExpression(init)) return `call ${boundedText(init.expression.getText(sf), 60)}(...)`;
  if (ts.isNewExpression(init)) return `new ${boundedText(init.expression.getText(sf), 60)}(...)`;
  if (ts.isStringLiteral(init) || ts.isNumericLiteral(init)) return `literal ${boundedText(init.getText(sf), 60)}`;
  if (ts.isIdentifier(init)) return `alias ${init.text}`;
  if (ts.isTemplateExpression(init) || ts.isNoSubstitutionTemplateLiteral(init)) return "template string";
  return ts.SyntaxKind[init.kind] ?? "expression";
}

/**
 * Module-local declarations for worker envelope grounding: same-file exports
 * and non-exports plus direct import bindings, with exact names and bounded
 * declaration headers. Function bodies are never included, so no other
 * target's solution can leak through this field.
 */
export function localDeclarations(source: string, filename = "source.ts", limit = 64): LocalDeclaration[] {
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const out: LocalDeclaration[] = [];
  const spanOf = (node: ts.Node): [number, number] => [
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
  ];
  const isExported = (node: ts.Node): boolean =>
    Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  const headerOf = (node: ts.Declaration & { body?: ts.Node }): string => {
    const end = node.body ? node.body.getStart(sf) : node.getEnd();
    return boundedText(source.slice(node.getStart(sf), end), 320);
  };
  const bindingNames = (name: ts.BindingName, acc: ts.Identifier[] = []): ts.Identifier[] => {
    if (ts.isIdentifier(name)) acc.push(name);
    else for (const el of name.elements) if (ts.isBindingElement(el)) bindingNames(el.name, acc);
    return acc;
  };
  for (const node of sf.statements) {
    if (out.length >= limit) break;
    if (ts.isImportDeclaration(node)) {
      const from = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
      const signature = boundedText(node.getText(sf), 240);
      const clause = node.importClause;
      if (clause?.name) out.push({ name: clause.name.text, kind: "import", signature, span: spanOf(node), imported_from: from, imported_name: "default" });
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        out.push({ name: bindings.name.text, kind: "import", signature, span: spanOf(node), imported_from: from, imported_name: "*" });
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          out.push({
            name: el.name.text, kind: "import", signature, span: spanOf(el), imported_from: from,
            ...(el.propertyName ? { imported_name: el.propertyName.text } : {}),
          });
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      out.push({ name: node.name.text, kind: "function", ...(isExported(node) ? { exported: true } : {}), signature: headerOf(node), span: spanOf(node) });
    } else if (ts.isClassDeclaration(node) && node.name) {
      // Never slice class text: a class node has no single body node, so a
      // text slice would leak method bodies. Header + member names only.
      const members = node.members.map((m) => m.name?.getText(sf)).filter(Boolean).slice(0, 12);
      const heritage = (node.heritageClauses ?? []).map((h) => h.getText(sf)).join(" ");
      out.push({
        name: node.name.text, kind: "class", ...(isExported(node) ? { exported: true } : {}),
        signature: boundedText(`class ${node.name.text}${heritage ? ` ${heritage}` : ""} // members: ${members.join(", ")}`, 320), span: spanOf(node),
      });
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      out.push({
        name: node.name.text, kind: ts.isInterfaceDeclaration(node) ? "interface" : "type",
        ...(isExported(node) ? { exported: true } : {}), signature: boundedText(node.getText(sf), 600), span: spanOf(node),
      });
    } else if (ts.isEnumDeclaration(node)) {
      out.push({
        name: node.name.text, kind: "enum", ...(isExported(node) ? { exported: true } : {}),
        signature: boundedText(`enum ${node.name.text} { ${node.members.map((m) => m.name.getText(sf)).join(", ")} }`, 320), span: spanOf(node),
      });
    } else if (ts.isVariableStatement(node)) {
      const kw = node.declarationList.flags & ts.NodeFlags.Const ? "const"
        : node.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
      for (const decl of node.declarationList.declarations) {
        const annotation = decl.type ? `: ${boundedText(decl.type.getText(sf), 160)}`
          : decl.initializer ? ` = ${describeInitializer(decl.initializer, sf)}` : "";
        for (const id of bindingNames(decl.name)) {
          out.push({
            name: id.text, kind: "variable", ...(isExported(node) ? { exported: true } : {}),
            signature: boundedText(`${kw} ${id.text}${annotation}`, 320), span: spanOf(decl),
          });
        }
      }
    }
  }
  return out.slice(0, limit);
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
 * Compiler options for a workspace file: the nearest tsconfig wins, so the
 * splice pre-check judges the file in the project's own ambient environment
 * (libs, types, path mappings). Hardcoded es2022-only options rejected
 * original bodies using project globals such as TextEncoder (DOM lib),
 * which the project's actual gate accepts.
 */
function projectCompilerOptions(absPath: string): ts.CompilerOptions {
  const fallback: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], allowImportingTsExtensions: true,
  };
  const configPath = ts.findConfigFile(dirname(absPath), ts.sys.fileExists, "tsconfig.json");
  if (!configPath) return fallback;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return fallback;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
  return {
    ...parsed.options, noEmit: true,
    allowImportingTsExtensions: parsed.options.allowImportingTsExtensions ?? true,
  };
}

/**
 * Typecheck one workspace file in a real program (module context), returning
 * diagnostics as text. Used after a code splice before the write is admitted.
 */
export function typecheckFile(absPath: string, sourceOverride?: string): string[] {
  const options: ts.CompilerOptions = projectCompilerOptions(absPath);
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
