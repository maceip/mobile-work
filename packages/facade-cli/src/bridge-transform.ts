import * as ts from "typescript";

/**
 * Training-facade compilation stage (bridge only).
 * Audit: ported essentials of zfacade-tinker zcode_patch/compiler.mjs audit()
 * (explicit T, no any/unknown anywhere in T, no shadowed facade bindings).
 * Transform: askData/askCode become typed asks on dedicated worker actors with
 * a JSON instruction envelope; sh.* intrinsics run natively (vendored E7).
 * The transformed text is what the real compiler/engine execute; both hashes
 * are recorded on receipts.
 */
export interface AuditDiagnostic { code: string; message: string; line: number | null }
export interface AuditHole {
  kind: "askCode" | "askData"; typeText: string | null; line: number; forbidden: boolean;
  /** Checker-resolved expansion of T (R3: never a bare alias alone). */
  resolvedType: string | null;
}
export interface AuditResult {
  diagnostics: AuditDiagnostic[]; holes: AuditHole[]; strictClean: boolean;
  /** Top-level type alias/interface declarations from the workflow source (bounded). */
  typeDefs: string;
}

/** Expand a checker type to self-contained text (function types structurally). */
function expandType(checker: ts.TypeChecker, type: ts.Type, at: ts.Node): string {
  const sigs = type.getCallSignatures();
  const first = sigs[0];
  if (first) {
    const params = first.parameters.map((p) => {
      const decl = p.valueDeclaration as ts.ParameterDeclaration | undefined;
      const rest = decl?.dotDotDotToken ? "..." : "";
      const opt = decl?.questionToken ? "?" : "";
      const ptype = checker.getTypeOfSymbolAtLocation(p, decl ?? at);
      return `${rest}${p.getName()}${opt}: ${checker.typeToString(ptype, undefined, ts.TypeFormatFlags.NoTruncation)}`;
    });
    const ret = checker.typeToString(first.getReturnType(), undefined, ts.TypeFormatFlags.NoTruncation);
    return `(${params.join(", ")}) => ${ret}`;
  }
  return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias);
}

const TRAINING_FACADE = `
export {};
declare global {
 interface SymbolRef { readonly file: string; readonly symbol: string; readonly digest: string; readonly signature?: string; }
 interface CodeArtifact<T> { readonly kind: 'code'; readonly contract: T; readonly artifactId: string; }
 function askCode<T>(spec: string, refs: readonly SymbolRef[]): Promise<CodeArtifact<T>>;
 function askData<T>(spec: string, refs: readonly SymbolRef[]): Promise<T>;
 const sh: {
  z_sig(target: string): Promise<readonly SymbolRef[]>;
  z_slice(file: string, start: number, end: number): Promise<string>;
  z_impact(symbol: string, dir: string): Promise<readonly SymbolRef[]>;
  z_verify(gateId: string): Promise<{exit_code: number; receiptId: string}>;
 };
}
`;

export function auditTraining(source: string): AuditResult {
  const files = new Map<string, string>([
    ["/virtual/turn.ts", "export {};\n" + source],
    ["/virtual/facade.d.ts", TRAINING_FACADE],
  ]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true,
    noEmit: true, types: [], lib: ["lib.es2022.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  host.readFile = (f) => files.get(f) ?? originalRead(f);
  host.fileExists = (f) => files.has(f) || originalExists(f);
  const originalSource = host.getSourceFile.bind(host);
  host.getSourceFile = (f, v, ...rest) =>
    files.has(f) ? ts.createSourceFile(f, files.get(f)!, v, true) : originalSource(f, v, ...rest);
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile("/virtual/turn.ts")!;
  // Compiler diagnostics about names the REAL facade provides (agent, phase, ...)
  // are not audit failures; the production compiler judges the transformed text.
  const diagnostics: AuditDiagnostic[] = [];
  const holes: AuditHole[] = [];

  const forbidden = (type: ts.Type, visited = new Set<number | ts.Type>(), depth = 0): boolean => {
    // Reference-type expansion (Promise<T>.then -> Promise<U> ...) mints fresh
    // type objects per step, so identity-based visited sets never terminate.
    // Key by the checker's stable type id and hard-cap depth/expansions.
    if (depth > 64 || visited.size > 4096) return false;
    const key = (type as { id?: number }).id ?? type;
    if (visited.has(key)) return false;
    visited.add(key);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    if (type.isUnionOrIntersection()) return type.types.some((t) => forbidden(t, visited, depth + 1));
    if (!(type.flags & ts.TypeFlags.Object)) return false;
    if ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
      if (checker.getTypeArguments(type as ts.TypeReference).some((t) => forbidden(t, visited, depth + 1))) return true;
    }
    // Only authored structure counts toward the hole contract: expanding the
    // lib surface of referenced types (Promise.then's `any` reason parameter,
    // Set.forEach's `any` thisArg) would reject every Promise/collection type.
    const symbol = type.getSymbol();
    const authored = (symbol?.declarations ?? []).some((d) => d.getSourceFile() === sf);
    const anonymous = !symbol || Boolean((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous);
    if (!authored && !anonymous) return false;
    const sigs = [...type.getCallSignatures(), ...type.getConstructSignatures()];
    if (sigs.some((s) => forbidden(s.getReturnType(), visited, depth + 1)
      || s.parameters.some((p) => forbidden(checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? sf), visited, depth + 1)))) return true;
    return type.getProperties().some((p) =>
      forbidden(checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? sf), visited, depth + 1));
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && (node.expression.text === "askCode" || node.expression.text === "askData")) {
      const kind = node.expression.text as "askCode" | "askData";
      const symbol = checker.getSymbolAtLocation(node.expression);
      const declaredInFacade = symbol?.declarations?.some(
        (d) => d.getSourceFile().fileName === "/virtual/facade.d.ts");
      if (symbol && !declaredInFacade) {
        diagnostics.push({ code: "SHADOWED_FACADE", message: "Facade bindings cannot be replaced.", line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line });
      }
      const typeNode = node.typeArguments?.[0];
      const type = typeNode ? checker.getTypeFromTypeNode(typeNode) : undefined;
      const invalid = !type || forbidden(type);
      if (invalid) {
        diagnostics.push({
          code: "UNSAFE_HOLE_TYPE",
          message: "Explicit T must not contain any/unknown, including nested properties/signatures.",
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line,
        });
      }
      holes.push({
        kind, typeText: typeNode?.getText(sf) ?? null,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line, forbidden: invalid,
        resolvedType: type && !invalid ? expandType(checker, type, node) : null,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const typeDefs = sf.statements
    .filter((s) => ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s))
    .map((s) => s.getText(sf).trim())
    .join("\n")
    .slice(0, 8192);
  return { diagnostics, holes, strictClean: diagnostics.length === 0, typeDefs };
}

const PROLOGUE = [
  "interface __ZfCodeResult { artifactId: string; targetId: string; applied: boolean }",
  'const __zf_code = agent("zf-code");',
  'const __zf_data = agent("zf-data");',
].join("\n") + "\n";

/** Rewrite askCode/askData calls to typed worker asks carrying a JSON envelope. */
export function transformTraining(source: string, audit?: AuditResult): string {
  const sf = ts.createSourceFile("turn.ts", source, ts.ScriptTarget.Latest, true);
  const factory = ts.factory;
  const holeQueue = [...(audit?.holes ?? [])];
  const typeDefsText = audit?.typeDefs ?? "";
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => (root) => {
    const visit: ts.Visitor = (node) => {
      const visited = ts.visitEachChild(node, visit, context);
      if (ts.isCallExpression(visited) && ts.isIdentifier(visited.expression)
        && (visited.expression.text === "askCode" || visited.expression.text === "askData")) {
        const kind = visited.expression.text;
        const spec = visited.arguments[0] ?? factory.createStringLiteral("");
        const refs = visited.arguments[1] ?? factory.createArrayLiteralExpression([]);
        const typeText = visited.typeArguments?.[0]?.getText(sf) ?? "";
        const hole = holeQueue.shift();
        const resolvedType = hole?.resolvedType ?? "";
        // Project SymbolRefs to plain {f,s,d} records: passing the facade-typed
        // values opaquely into JSON.stringify trips upstream facade-misuse 9001.
        const projParam = factory.createParameterDeclaration(
          undefined, undefined, "__r", undefined,
          factory.createTypeReferenceNode("SymbolRef", undefined));
        const projected = factory.createCallExpression(
          factory.createPropertyAccessExpression(refs as ts.Expression, "map"),
          undefined,
          [factory.createArrowFunction(undefined, undefined, [projParam], undefined,
            factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
            factory.createParenthesizedExpression(factory.createObjectLiteralExpression([
              factory.createPropertyAssignment("f", factory.createPropertyAccessExpression(factory.createIdentifier("__r"), "file")),
              factory.createPropertyAssignment("s", factory.createPropertyAccessExpression(factory.createIdentifier("__r"), "symbol")),
              factory.createPropertyAssignment("d", factory.createPropertyAccessExpression(factory.createIdentifier("__r"), "digest")),
            ], false)))],
        );
        const envelope = factory.createCallExpression(
          factory.createPropertyAccessExpression(factory.createIdentifier("JSON"), "stringify"),
          undefined,
          [factory.createObjectLiteralExpression([
            factory.createPropertyAssignment("zf", factory.createStringLiteral(kind === "askCode" ? "code" : "data")),
            factory.createPropertyAssignment("spec", spec as ts.Expression),
            factory.createPropertyAssignment("refs", projected),
            factory.createPropertyAssignment("typeText", factory.createStringLiteral(typeText)),
            factory.createPropertyAssignment("typeResolved", factory.createStringLiteral(resolvedType)),
            factory.createPropertyAssignment("typeDefs", factory.createStringLiteral(typeDefsText)),
          ], false)],
        );
        const actor = factory.createIdentifier(kind === "askCode" ? "__zf_code" : "__zf_data");
        const typeArgs = kind === "askCode"
          ? [factory.createTypeReferenceNode("__ZfCodeResult", undefined)]
          : visited.typeArguments;
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(actor, "ask"), typeArgs, [envelope]);
      }
      return visited;
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  };
  const result = ts.transform(sf, [transformer]);
  const printed = ts.createPrinter().printFile(result.transformed[0]!);
  result.dispose();
  return PROLOGUE + printed;
}
