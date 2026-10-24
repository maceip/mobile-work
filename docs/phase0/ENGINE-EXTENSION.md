# Phase 0 engine extension: bounded coding steps + training bridge

## Ownership (plan §4.4)

Coordinator (facade-cli) owns admission, workspace lock, recovery, process
supervision. WorkflowEngine (vendored) owns next-operation ordering. Agent step
machine (facade-agent) owns conversation transitions only. EffectService
(facade-core) owns authorization, receipts, cancellation, reconciliation.
SqliteJournalStore (facade-core) owns transactions. No unjournaled helper runs a
step behind a nominal node (plan §4.1).

## Trusted skeleton (CLI path)

Host-authored, versioned script `SKELETON_SOURCE` (facade-agent, SHA-256 pinned
in code + recorded on every run row). Shape:

```ts
phase("coding");
const coder = agent("coder", { system: SKELETON_SYSTEM });
let step = await coder.ask<StepResult>(firstInstructions);
// Each ask = one bounded model step. The driver runs admitted tools serially
// inside the ask, then settles the ask with a typed StepResult. The loop lives
// in the skeleton (engine-visible asks), never inside the driver.
while (!step.done) { step = await coder.ask<StepResult>(continueInstructions(step)); }
return step;
```

`StepResult` is a script-local interface, so the vendored schema synthesizer
builds the ask schema and the vendored validator enforces typed submission
semantics (accept/reject/nudge preserved). Driver step pipeline per ask:
`prepareStep` (committed transcript revision) → `requestModel` (one provider
attempt; complete response validated before tools) → `acceptModelResponse`
(persist assistant content + ordered intents) → `executeTool` ×N serial via
EffectService → `settleStep` (submit typed result to engine sink). Provider
transport retries stay inside one attempt record; no tool dispatch mid-retry.

World operations in any script (`files.*`, `git.*`, `world.run`) execute in the
driver through the same tools/effect service. `world.run` requires a Bash grant
for the exact argv; reads require workspace-confined paths (D6).

## Training bridge mapping (protocol v1)

NDJSON over stdio, 1 MB caps, typed infrastructure errors vs in-result model/
compiler observations (bridge_protocol.md). Methods:

- `hello`: protocol, versions (facade, compiler, runtime), capabilities list.
  Capabilities advertised only after tests pass: `compiled_facade`,
  `typed_code_splice`, `typed_data_validation`, `flat_subgraphs`,
  `dependency_replay`, `isolated_effects`, `immutable_test_gates`.
- `open`: canonicaize workspace (must exist; episode writes confined there),
  pin gates (`argv`, `typecheck_argv`, `protected_files` + SHA-256 snapshot),
  pin limits (worker calls, graph nodes, expansions, tool timeout). Returns
  episode/run/revision IDs. Arbitrary gate commands are not accepted later;
  only pinned argv run, as recorded effects.
- `submit_workflow(ts_code)`: real compile → analyze (sites, holes, causality
  dependencies) → lower → `runWorkflowScript` with bridge driver. Execution
  pauses (in-process, journaled) when a worker is required.
- Worker dispatch: `{"status":"worker_required","request":{...}}` with
  `request_id`, node/revision, `kind` (`code|data|subgraph`), target identity +
  expected body hash (code), serialized type + imports (data/code), root
  digest + obligations + scoped anchors (subgraph), remaining limits. No
  solution/teacher/hidden-test content is included.
- `resolve_worker`: envelope per `prompts/worker.md`. Code: AST-category parse
  + `spliceHoleBody` + stability check + full recompile/typecheck before
  `fillHole`. Data: JSON parse + vendored schema validation; wrong JSON is an
  observation, never a file write. Subgraph: ported `validate_subgraph`
  (strict-subset obligations, scope containment, root digest, full coverage,
  no duplicates) + composed typecheck; children execute as root-graph nodes.
  Stale request/checkpoint/revision rejected. Checkpoint identity is part of
  cache keys (contracts `replay_key` ported).
- `amend_workflow(hole_id, revision, updated_ts_code)`: stable-site check,
  dependency invalidation set from the analysis causality graph (transitive
  dependents; ported `invalidated_nodes` semantics), successor run via
  amend-resume imported cache; unaffected receipts replay without re-execution.
- `cancel`/`close`: persist fence, abort owned process trees, settle stopped
  receipt; `close` idempotent.
- Observation receipt: status, bounded diagnostics, hole IDs/revision, boolean
  outcomes (`verified_green, compile_clean, meaningful_progress,
  no_unresolved_holes, typecheck_pass, tests_pass, tests_unchanged,
  policy_violation, test_tampering`), run/facade/source/graph/contract hashes,
  test/effect receipt IDs, failed attempts, max depth, reuse/invalidation
  counts, measured ms. `verified_green` only when compile clean, pinned
  typecheck+tests pass on final snapshot, protected hashes unchanged, no
  unresolved holes, no policy violation. Python side re-verifies independently.

## Risk note (honest boundary)

Bridge `submit_workflow` executes orchestrator-sampled TypeScript in the VM
child. Mitigations shipped: minimal child environment, all filesystem/process
effects mediated by the parent driver + effect service, episode workspace
confinement, pinned gates, timeouts/caps. `node:vm` is not an OS sandbox
(plan §6.2); A14 remains open and no sandbox claim is made. CLI model-authored
execution stays analysis-only; the trusted skeleton is the only auto-executed
CLI script.
