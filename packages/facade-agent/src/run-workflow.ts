import {
  analyzeWorkflowScript, buildAskSpecs, collectDiagnostics, collectSitePhases,
  collectSites, createWorkflowProgram, lowerWorkflowScript, synthesizeAskSchemas, validate,
  type AnalyzeResult, type AskSpec, type CompileDiagnostic, type ImportedRunCache, type JsonSchema,
  type RunSettlement, type SiteTable, type ValidateFn, type WorkflowProgram,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript, type RunControlBinding } from "@zcode/dynamic-workflow-runtime";
import { sha256Hex } from "@zfacade/contracts";
import type { WorkspaceStore } from "@zfacade/core";
import type { BoundedDriver } from "./driver.js";

export const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

export interface PreparedWorkflow {
  ok: boolean;
  diagnostics: CompileDiagnostic[];
  program?: WorkflowProgram;
  table?: SiteTable;
  askSpecs?: Map<string, AskSpec>;
  sitePhases?: Map<string, string>;
  analysis?: AnalyzeResult;
  scriptHash: string;
}

/** One compiler program feeds sites, schemas, and phases ("compile once"). */
export function prepareWorkflow(scriptText: string): PreparedWorkflow {
  const scriptHash = sha256Hex(scriptText);
  const lowered = lowerWorkflowScript(scriptText);
  if (!lowered.ok) return { ok: false, diagnostics: lowered.diagnostics, scriptHash };
  const program = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(program.program);
  if (diagnostics.length > 0) return { ok: false, diagnostics, scriptHash };
  const table = collectSites(program);
  const { schemas } = synthesizeAskSchemas(program, table);
  const askSpecs = buildAskSpecs(table, schemas);
  const analysis = analyzeWorkflowScript(scriptText);
  const sitePhases = analysis.core ? new Map(collectSitePhases(analysis.core)) : new Map<string, string>();
  return { ok: analysis.ok, diagnostics: analysis.diagnostics, program, table, askSpecs, sitePhases, analysis, scriptHash };
}

export class EngineControl implements RunControlBinding {
  engine: Parameters<RunControlBinding["bind"]>[0] | undefined;
  bind(engine: Parameters<RunControlBinding["bind"]>[0]): void { this.engine = engine; }
}

export interface ExecuteRunOptions {
  store: WorkspaceStore;
  runId: string;
  scriptText: string;
  prepared: PreparedWorkflow;
  driver: BoundedDriver;
  args?: Record<string, unknown>;
  caps?: { maxConcurrency: number };
  signal?: AbortSignal;
  timeoutMs?: number;
  control?: EngineControl;
  name?: string;
  resumedFrom?: string;
  importedCache?: ImportedRunCache;
  spawnWrapper?: { command: string; argsPrefix: readonly string[] };
}

export function executeRun(opts: ExecuteRunOptions): Promise<RunSettlement> {
  if (!opts.prepared.ok || !opts.prepared.askSpecs) {
    throw new Error("executeRun requires a clean prepared workflow");
  }
  return runWorkflowScript({
    scriptText: opts.scriptText,
    runId: opts.runId,
    cwd: opts.store.workspacePath,
    caps: opts.caps ?? { maxConcurrency: 4 },
    askSpecs: opts.prepared.askSpecs,
    sitePhases: opts.prepared.sitePhases,
    validate: validateFn,
    scriptHash: opts.prepared.scriptHash,
    args: opts.args ?? {},
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.control ? { control: opts.control } : {}),
    ...(opts.resumedFrom ? { resumedFrom: opts.resumedFrom } : {}),
    ...(opts.importedCache ? { importedCache: opts.importedCache } : {}),
    ...(opts.spawnWrapper ? { spawnWrapper: opts.spawnWrapper } : {}),
    makeDriver: (sink) => {
      opts.driver.attach(sink);
      return opts.driver;
    },
  });
}
