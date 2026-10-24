# zfacade decision log

Authoritative plan: `plan_prime.md` SHA-256
`d401a2461e73eb08b0f529f238150345a7c253339e2837d20fdf18ec6d901c80`
(confirmed by user 2026-10-24; includes line-10 deferred-serving correction).

## User decisions D1–D9 (2026-10-24), with S4 amendment

- D1 (amended by S4): Complete Phase 0 and implement Phase 1 engine, tools,
  permissions, persistence, and recovery behavior this session. Leave the
  local-provider A1 exit gate pending. Do not claim complete Phase 1 acceptance.
  Immediate integration target is the training runtime bridge (protocol v1).
  Deterministic doubles are used for implementation and recovery tests. Real
  training evidence must later come from Tinker driving the actual runtime;
  training evidence does not satisfy the local CLI acceptance gate.
- D2 (deferred by S4): Provider adapter targets a configurable local
  OpenAI-compatible endpoint (base URL + model ID). No serving shim, server
  upgrade, substitute model, weight download, or bind selection this session.
  Tinker is training infrastructure, never the inference provider.
- D3: Node 24.14.0 via nvm, pnpm 10.33.2 via Corepack, user-local and
  project-scoped. Global defaults preserved. No mise.
- D4: Git initialized; `.gitignore` before staging; `plan_prime.md`
  authoritative; `PLAN.md` absent, not reconstructed. No commits until asked.
- D5: State root `~/.zfacade/`; workspace databases and artifacts under stable
  workspace identities; keep until explicit deletion; configurable retention;
  report disk usage; never persist credentials; worktrees are separate.
- D6: Headless allows Read/Grep/Glob inside workspace after canonical-path,
  symlink, and protected-path checks. Edit/Bash and external access require
  explicit grants from trusted CLI/user config. Missing grant => durable
  pending outcome + documented exit status. No dangerous bypass in Phase 1.
- D7: Produce Phase 0 artifacts, then proceed into Phase 1 without extra
  approval pause. Surface architectural contradictions or scope expansion.
- D8: Verify macOS arm64 now. Linux gates unverified (release gate open).
  Windows unsupported.
- D9: ITE read-only at `87b16e73c6c2ee0ddcc23b8b85b1255bbd1c2603`, read via
  Git objects only, dirty/untracked content excluded. Model-authored workflow
  execution stays gated on a platform isolation implementation passing A14;
  selecting a backend is insufficient. Training-bridge workflow execution is
  the user-directed exception path and is documented as effect-confined, not
  OS-sandbox-proven (see ENGINE-EXTENSION.md risk note).
- D10 (2026-10-24, amends D2 for **testing only**): Live shakeout uses the
  hosted OpenAI API (`provider.kind = "openai"`, key from `OPENAI_API_KEY` in
  env or `~/zfacade/.env`, never persisted). This is the testing framework's
  live provider (ALIGNMENT G3 / A1). Tinker remains the training
  optimizer/sampler, never the inference provider. Local OpenAI-compatible
  loopback (`kind: "openai-compatible"`) stays available for offline-style
  local servers. Deterministic doubles remain for unit/integration tests and
  must keep the `deterministic-test` receipt label. Priority order for
  shakeout: fix readiness R1–R7 and prove engine-owned loop stress **after**
  the OpenAI canary is green — not before live wiring.
- D11 (2026-10-24): **TypeScript only.** Strike multi-language generation
  (Python AST / tree-sitter / dual compilers) from the active plan. The
  workflow engine is the coding-loop / task-completion substrate, not a
  multi-language compiler suite. Training corpus and `askCode` splice/typecheck
  stay TS. Reopen G4 only on explicit user request.

## Phase 0 engineering decisions (within D7 authority)

- E1 Vendoring: copy `dynamic-workflow` (121 src files) and
  `dynamic-workflow-runtime` (6 src files) from ZCode `042d4f6a…` into
  `vendor/zcode-core/packages/`, keeping upstream package names and relative
  imports. External closure is `typescript` + Node builtins only (verified by
  import scan). Tests (25 + 16 files) and `scripts/generate-libs.mjs` included;
  `src/compiler/libs.generated.ts` is generated at build time (untracked
  upstream), never hand-edited.
- E2 Adaptations to vendored code are minimal, enumerated in PROVENANCE.json:
  (a) `engine-world`: a `running` world-run node on replay settles as
  `OutcomeUnknown` hold instead of live re-execution (plan §5.3); pure
  world-read retry preserved. (b) `WorkflowDriver.executeWorldRead` gains an
  optional `{runId, instance, kind}` context so the driver can key effect
  receipts (ITE precedent at pinned commit). (c) harness child spawn uses a
  minimal explicit environment allowlist; Electron/SEA branches removed
  (plan §6.2, §8.3). No other upstream algorithm changes.
- E3 Storage: `node:sqlite` `DatabaseSync` (verified on Node 24.14.0), one
  database per workspace under `~/.zfacade/workspaces/<key>/zfacade.sqlite`,
  WAL + `synchronous=FULL`, versioned migrations, single shared transaction
  service for journal + zfacade tables (plan §5.1–§5.2).
- E4 Bounded coding steps: a host-authored trusted skeleton script drives a
  single coding actor; each `ask` is one engine node; the driver executes one
  provider attempt per ask and runs admitted tool calls serially through the
  effect service, each with its own receipt (plan §4.2). Tool concurrency
  deferred. Provider is a port: real OpenAI-compatible HTTP implementation
  (live gate pending) + explicit deterministic test provider (never default).
- E5 Bridge worker dispatch maps to engine primitives: unfilled `hole()`
  sites and parked asks become `worker_required`; `resolve_worker` validates
  code (splice + typecheck via vendored compiler), data (vendored schema
  validator), or subgraph (ported `validate_subgraph` contraction) before
  `fillHole`/submit. No nested engine.
- E6 Phase 2 surfaces (REPL, memory actor, compaction, general subagent tool,
  MCP/hooks) are absent from catalogs and CLIs, not stubbed (plan §8.4).

## Readiness-fix decisions (2026-10-24, readiness-review R1–R7)

- F1 (R1) One terminal-success predicate in TS and Python; receipts carry
  settlement and unresolved-work fields; consumers reject inconsistent pairs.
- F2 (R2) Bridge episodes run under a macOS seatbelt profile (vendored E8
  `spawnWrapper` for the VM child; sandboxed tool/gate subprocesses; Python
  verifier mirror), fail-closed when unavailable. Seatbelt is write/network/
  credential confinement, not full OS isolation; A14 remains open. CLI `run`
  keeps the unsandboxed trusted-grant model.
- F3 (R5) `flat_subgraphs` withdrawn from the pilot; subgraph envelopes fail
  closed; decomposition means sequencing separate asks.
- F4 (R4) askCode binding is strict: fresh digests (or host lineage), checker
  contract compatibility at dispatch and apply, required identity/hash.
- F5 (R6) Verification observations never import across amendments; the
  invalidated site set filters all imported cache entries.
  Details and proofs: docs/phase1/R-FIXES.md.
