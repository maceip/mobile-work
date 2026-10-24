# Readiness fixes R1–R7 (2026-10-24)

Source of truth: [readiness-review.md](../../readiness-review.md). Each fix lists
trigger, root cause, mechanism, and regression proof. No paid training ran.
Maintained regressions live in `packages/facade-cli/tests/bridge.test.ts`
(R1–R7 blocks), `packages/facade-agent/tests/sandbox.test.ts`,
`packages/facade-contracts/tests/contracts.test.ts`, and
`zfacade-tinker/tests/test_episode_offline.py` + `test_contracts.py`.
The original review scripts under `/tmp` were re-run after the fixes; every
probe flipped (values quoted below).

## R1 (P0) Invalid outcomes became successful rewards

- Trigger: passing task + `z_verify("unregistered-gate")` returned
  `status=errored, verified_green=true`; cancellation returned green with
  `no_unresolved_holes=true`; env scored repair-then-invalid-gate 0.999988.
- Root cause: `buildReceipt` computed `verified_green` from fresh final gates
  alone (`void status`), `cancel()` cleared pending work before the receipt,
  and the Python consumer trusted success flags without settlement checks.
- Mechanism: one shared terminal-success predicate
  (`isTerminalSuccess` in facade-contracts, `terminal_success` in
  tinker_recipe/contracts.py): completed settlement + clean compile + fresh
  typecheck/tests + unchanged protected files + no unresolved holes + no
  policy violation/tampering + zero pending/held/denied effects. Receipts now
  carry `settlement_status`, `cancelled`, `open_holes`, `pending_workers`,
  `pending_effect_ids`, `held_effect_ids`, `denied_effect_ids`, computed from
  authority state at receipt time. Cancel retains pending work in the receipt.
  Denied operations classify as `policy_violation` (denied effect rows and
  driver world-op denials). Consumer rejects inconsistent status/receipt
  pairs before scoring; `reward()` raises on non-terminal green.
- Proof: bridge tests R1×3; contracts predicate matrix; python
  `test_reward_rejects_nonterminal_green`; review probes now print
  errored/cancelled green=false; env probe repair-then-invalid-gate reward
  changed 0.999988 → -1.0 (policy violation).

## R2 (P0) Generated source ran outside any enforced boundary

- Trigger: a worker body using `Function("return process")()` wrote outside
  the episode workspace during verification and still earned green.
- Root cause: verifier and generated workflows executed as ordinary host
  processes; directory scoping and environment stripping were treated as
  isolation. They are not.
- Mechanism: macOS seatbelt (`sandbox-exec`) profile per episode, created with
  live self-probes at `open` (fail closed as infrastructure error when
  unavailable or non-confining). The profile confines writes to the episode
  workspace + episode temp/home, denies network, denies reads of credential
  and dataset locations (passwd-anchored, never `$HOME`-anchored), and is
  inherited by descendants. Applied to the VM child (vendored E8
  `spawnWrapper`), every tool/gate subprocess (sandboxed `runArgv` with
  episode HOME/TMPDIR), and the Python independent verifier
  (`local_tools._Sandbox`). Honest boundary: seatbelt is kernel-enforced
  write/network/credential confinement, not a container or VM; world-readable
  host files outside the deny list remain readable; CPU/memory are bounded by
  wall-clock timeout + process-group kill. Full A14 isolation stays open.
  `node:vm` is not claimed as a sandbox anywhere.
- Proof: sandbox unit tests (outside write, descendant escape, network,
  timeout kill); bridge R2 tests (outside write sentinel absent, credential
  read makes tests fail, no green); extra review probe now prints
  `outside_write_observed: false, verified_green: false`.

## R3 (P1) Worker envelopes lacked contract/context

- Trigger: dispatch carried `type_declaration: "Sum"` plus hashes only.
- Root cause: the transform embedded the alias text; requests carried no
  declaration, parameters, imports, task, or evidence.
- Mechanism: audit resolves T with the checker (`resolved_type` structural
  expansion + workflow `type_definitions`); requests now carry
  `target_declaration`, `parameters`, `current_body`, `required_imports`,
  immutable `task`, bounded public-test `evidence`, anchors, and a separate
  `diagnostics` channel (contract fields never mutate on redispatch).
- Proof: renamed-parameters bridge test — the worker builds the body solely
  from `request.parameters` (`alpha + beta`) and completes green; review
  worker-context probe now shows the resolved signature inline.

## R4 (P1) askCode<T> never enforced T against its target

- Trigger: `askCode<(text: string) => boolean>` bound `sum` and a numeric body
  passed with green.
- Root cause: no T-vs-target check existed; identity/hash had silent fallbacks
  (first remaining target, request/current hash).
- Mechanism: dispatch-time strict binding — every ref must resolve inside the
  workspace, match a supported exported function, carry a fresh digest (or
  host-verified lineage from this episode's own splice), and pass a two-way
  checker assignability test between T and the target (`checkContract`).
  Zero/ambiguous/stale bindings fail the ask with a structured diagnostic.
  Apply time requires `target_id` + `expected_body_hash`, re-checks the
  contract, and asserts the splice changed only the body (signature and
  declaration text identical post-splice).
- Proof: bridge R4 tests (incompatible T errored with contract diagnostics,
  nothing written; missing identity redispatched, exact identity succeeds);
  review incompatible-contract probe now settles errored at dispatch.

## R5 (P1) Advertised subgraphs were target sequencing

- Trigger: invalid-TypeScript subgraph with wrong root digest "succeeded"
  twice; depth incremented without executing proposed source.
- Root cause: successor handler ignored `source`/`root_digest` and reordered
  pre-bound targets.
- Mechanism: fail closed (the review's accepted alternative). Subgraph
  envelopes receive an explicit not-supported diagnostic and execute nothing;
  `flat_subgraphs` is removed from bridge hello, TS and Python required
  capability sets, worker/orchestrator prompts, and the protocol document.
  Decomposition in the pilot means sequencing separate asks. The
  `validate_subgraph` contraction port remains for a future real
  implementation; nothing presents sequencing as subgraph support.
- Proof: bridge R5 test (invalid subgraph rejected twice, obligations
  unchanged, `max_depth` stays 1, leaves then complete green).

## R6 (P1) Stale verification observations drove successor control flow

- Trigger: fail→amend→correct-body replayed the old failing `z_verify`,
  threw, and final fresh gates still produced green.
- Root cause: invalidation was counted, not applied; imported cache included
  completed `world-run` verification nodes.
- Mechanism: the invalidated site SET now filters the imported cache (ask
  prefixes stop before invalidated asks; invalidated world-read sites are
  dropped), and `world-run` observations are never imported — successors
  always execute gates fresh. Historical receipts stay in the journal.
- Proof: bridge R6 tests fail-to-pass (fresh verify decides, green) and
  pass-to-fail (no stale rescue), sibling reuse without duplicate dispatch.

## R7 (P1) Compiler feedback was discarded

- Trigger: observations showed `diagnostics: ["[object Object]"]`.
- Root cause: `.map(String)` over structured diagnostic objects.
- Mechanism: one `toDiagnostic` boundary in the bridge — every diagnostic is a
  bounded `{code, message, line?, column?, file?}` object end to end.
- Proof: bridge R7 test asserts shape and content; review compile probe now
  prints `{"code":"2322","message":"Type 'string' is not assignable..."}`.

## Still deferred

- Full A14 OS isolation (containers/VM or equivalent) — seatbelt is the
  training-platform boundary, documented above with its non-claims.
- Real subgraph execution; data subgraphs; multi-actor fan-out; REPL, memory,
  compaction, MCP/hooks, saved workflows (unchanged Phase 2+ scope).
- Live worker evidence: all bridge workers in tests are scripted doubles.
  Acceptance gates 3–5 (corpus replay with host-private repairs, sampling-only
  canary, one-step optimizer smoke) have not run and need explicit approval.
- Linux verification of every gate (seatbelt is macOS-only; the Python and TS
  sandboxes fail closed off Darwin).
