# Phase 0 source map and dependency closure

Paths relative to `ZCode/apps/zcode-cli/packages/` at `042d4f6a…` unless noted.
Closure method: static import scan of `src/**` (external specifiers), package
manifests, and entry-point reads. Dynamic imports checked in vendored runtime
(child entry is generated source text, inventoried below).

## Vendored verbatim (plus enumerated adaptations E2)

| Source | Destination | Closure |
| --- | --- | --- |
| `dynamic-workflow/src/**` (121 .ts), `tests/**` (25 test files + smoke corpus), `scripts/generate-libs.mjs`, `scripts/generate-mermaid.mjs`, `package.json`, `tsconfig.json` | `vendor/zcode-core/packages/dynamic-workflow/` | `typescript` only; `vitest` in `src/testing/**` + tests (dev) |
| `dynamic-workflow-runtime/src/**` (6 .ts: harness, protocol, child-entry-file, child-source, child-cell-streams, index), `tests/**` (16 files), `package.json`, `tsconfig.json` | `vendor/zcode-core/packages/dynamic-workflow-runtime/` | `@zcode/dynamic-workflow` + `node:child_process/fs/os/path/readline/url/v8/vm` |
| ZCode root `LICENSE`, `NOTICE.md` | `vendor/zcode-core/` | — |

Key upstream surfaces consumed by facade code (all read during Phase 0):
`compileWorkflowScript`/`createWorkflowProgram` (compiler/compile.ts),
`analyzeWorkflowScript` (analysis/analyze.ts), `collectSites`/`collectSitePhases`
(ask specs + phases), `spliceHoleBody`/`checkSiteStability` (hole splice),
schema `validate`/`synthesize` (typed asks), `WorkflowEngine` + `fillHole` +
`openHoles` (engine), `JournalStorePort` (engine/types.ts),
`runJournalStoreContract` (testing), `runWorkflowScript` (runtime harness),
facade registry ops: `glob/read/grep/git-changed-files/git-diff/git-status/git-log/run`.

## Implemented as zfacade facade code (behavior ported, not file-copied)

Upstream `core` (573 files), `adapters` (221), `contracts` (120), and
`bootstrap` (284) carry desktop/remote/product transitive imports (cheerio,
playwright-core, koffi, Electron seams) that plan §8.4 cuts. Phase 1 ports the
required behaviors behind facade ports instead of copying those trees:

| Behavior (upstream anchor) | zfacade owner |
| --- | --- |
| SQLite journal (`adapters/.../dwf-journal*.ts` semantics; audited fresh schema per plan §8.3) | `facade-core` SqliteJournalStore (passes vendored contract suite) |
| Turn loop one-iteration semantics (`core/.../turn-loop.ts`, `turn-model-step`, `turn-tools`) | `facade-agent` bounded step driver (no independent while loop) |
| Tool handlers/registry/executor + serializers (`contracts/src/tools`, `core/src/tool`) | `facade-agent` tools: Read, Write, Edit, ApplyPatch, Bash, Grep, Glob |
| Permission ladder/broker/Bash analysis/path policy (`core/src/permission`) | `facade-core` PermissionService (modes, exact grants, readonly family, path fence) |
| Provider transport (`adapters/src/model`, openai-compatible path) | `facade-agent` OpenAI-compatible provider port (live gate pending) |
| Driver/world/artifact helpers (`bootstrap/.../workflow-driver*.ts`) | `facade-agent` BoundedDriver (world reads/run, artifact publish) |
| Command admission FIFO/receipts (`bootstrap/.../command-inbox.ts`) | `facade-core` command table + coordinator (local subset) |

## Excluded (plan §8.4): Electron/renderers, remote/relay/cloud, marketplace,
telemetry, office/browser/CUA, hooks/MCP/skills/general Agent tool (deferred),
memory dream/semantic selection, Rust/Duroxide. Excluded packages must not
appear in bundle/import scans; CI check `scripts/check-boundaries.mjs` enforces
package directions (contracts ← core ← agent ← cli; vendor standalone).

## ITE comparison (pinned commit Git objects only)

ITE `vendor/open-agent-core` derives from older ZCode `29628c9…`. Recorded local
changes: one-program analysis, world site identity to driver (adopted as E2b),
opt-in Linux Bubblewrap (not adopted; macOS has no Bubblewrap, A14 open).
ITE Rust/Duroxide host is research input only. No ITE files are copied.
