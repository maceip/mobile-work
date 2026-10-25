# Evidence status (corrected 2026-10-24 after readiness review)

Phase 1 is **not ready for training data generation** until the remaining
acceptance gates in [readiness-review.md](../../readiness-review.md) pass.
Earlier green totals in this file were overstated: the bridge scored invalid
outcomes as successes (R1) and generated code ran without an enforced boundary
(R2). Those claims are withdrawn. Fixes and proofs: [R-FIXES.md](./R-FIXES.md).

## Labels (never blurred)

- `deterministic-test`: scripted fake sampler/worker. Proves plumbing only.
- **live**: a real model endpoint was invoked; transcripts/hashes preserved.
- **scripted bridge worker**: test code returns envelopes over the real bridge
  process. Proves the wire/host path, not model behavior.

## Verified now (fresh, this fix pass)

Commands (Node 24.14.0, pnpm 10.33.2, from `/Users/mac/zfacade`):

| Gate | Result |
| --- | --- |
| `pnpm -r --sort build` / `typecheck` | Clean (6 packages) |
| `pnpm -r --sort test` | contracts 9, core 88, agent 5, cli 24, vendored workflow 1983, runtime 98 — all pass |
| `node scripts/vendor-provenance.mjs` | 2089 copy / 11 adapted (E2a–E2c, E7, E8) / 1 generated / 2 added |
| `node scripts/check-boundaries.mjs` | ok |
| Tinker `scripts/check_local.sh` | PASS (npm test, 17 unittests incl. offline episode, smoke, compileall) |
| Review scripts (3, /tmp) | Every probe flipped: errored/cancelled green=false; outside write unobserved; structured diagnostics; env invalid-gate reward -1.0, valid repair ~1.0 |
| Live OpenAI canary (prior session, D10) | Green; artifacts under [evidence/live-openai](../../evidence/live-openai) |

Bridge acceptance mapping is in [R-FIXES.md](./R-FIXES.md). Receipts now carry
settlement and unresolved-work fields; `verified_green` is set only by the
shared terminal-success predicate. Bridge episodes run under a macOS seatbelt
profile (write-confined, network denied, credential reads denied) that fails
closed when unavailable; that is a training-platform boundary, not full OS
isolation (A14 open). `flat_subgraphs` is withdrawn from the pilot.

## Gates 3–4 (run 2026-10-24, per GATE-DECISIONS.md)

- **Gate 3 corpus**: mined from hunk `1b7ceb57` (windowed AST excision,
  seatbelt-verified pass/fail/pass per task). 596 attempts, 358 accepted,
  340 selected: train 272 / validation 34 / test 34, family-disjoint.
  Vivari contributed 0 cases (no tracked `*.test.ts` files at HEAD);
  Multi-SWE-bench was not needed for volume. Replay of all 340 rows with
  host-private reference repairs: 340/340 broken reproduced and restored
  green, 0 leakage problems. Artifacts (gitignored, local):
  `zfacade-tinker/data/local/zcode_tasks.jsonl`,
  `runs/gate3-replay/20261024T184333/`.
- **OpenAI bridge shakeout (gpt-5.5, live)**: 4 episodes on 2 test tasks
  (2 minimal prompt, 2 full manual). 0 verified green, 0 infrastructure
  errors; rewards 0.0–0.05. One live worker dispatch (askData leaf) in the
  manual-prompt pair. Failure mode is zero-shot facade discovery within
  6 turns, not bridge correctness: no false green was ever produced.
  Artifacts: `zfacade-tinker/runs/openai-shakeout/20261024T184915/` and
  `20261024T185048/`.
- **Gate 4 canary (small-4b, sampling-only, live Tinker)**: 10 test tasks,
  119,173 prompt + 6,926 completion tokens, 0 worker calls, estimated
  $0.046 of the $50 cap, 0 optimizer updates. 0 verified green; 9/10
  settlements compile_error, 1 completed (reward 0.05). Service, renderer
  tool-call parsing, bridge receipts, and caps all exercised live; the
  Tinker **worker** sampling path was not reached because the base
  orchestrator never produced a workflow that dispatched a worker.
  Artifacts: `zfacade-tinker/runs/canary-small-4b/20261024T185238/`.

## Gate 5 + Stage 1 SDFT (run 2026-10-24, Option 2)

- **Shaping fix**: partial credit (0.05) now strictly requires
  `worker_calls >= 1` in both bridge receipt and consumer reward; the
  Gate 4 verify-only 0.05 is unreachable. Bridge regression `G5` and
  consumer reward tests cover it.
- **Worker path proof**: forced-teacher orchestrator + live Tinker worker
  on 3 test tasks — after fixing two generator defects (inlined
  declarations carried illegal `export` modifiers; teacher asks passed a
  whole file's refs to single-signature asks, failing R4 binding) the
  run compiled 3/3, dispatched 19 live worker calls, 0/3 verified green
  (base worker body-contract errors/redispatch loops). Corpus re-mined
  and replayed 340/340 again after both fixes. Student prompts now carry
  the public target declarations (teacher/student context parity).
- **SDFT smoke**: 1 optimizer step (batch 4), loss:sum 614.7, checkpoint
  write/read and resampling verified. First attempt found the service
  `topk_prompt_logprobs <= 20` limit; configs corrected from 64 to 20.
- **Stage 1 SDFT**: 35 steps × batch 16 on the 272-task train split,
  2,169,719 accounted tokens, worst-case spend $2.18 vs the $5 cap.
  Checkpoints at steps 10/20/30/35 (`checkpoints/small/stage1/`, local
  manifests + `tinker://` state). Loss means moved first-5 2704 → last-5
  2074 (batch-dependent sums; noisy).
- **Post-SDFT canary**: same 10 test tasks, orchestrator = step-35
  checkpoint, worker = base. 0/10 verified green, 0 worker dispatches,
  all rewards 0.0. Teacher surface patterns increased vs base
  (`refs.filter` 0→13, inlined interfaces 0→9) but no episode compiled
  through to a worker dispatch. SDFT alone is not yet capability.

## Mixed Stage 1 + verification gate (run 2026-10-24)

- **Canary compile diagnosis** (post-SDFT 10): 4 episodes died turn 1 on
  tool-namespace confusion (`askCode<…>` emitted as the tool name), 4 on
  module code inside `ts_code` (TS1232/2307/1184/SHADOWED_FACADE), 3 hit
  UNSAFE_HOLE_TYPE, 1 truncated at 1024 tokens.
- **Worker body contract**: of the 19 forced-teacher calls, 10 bodies had
  imports, 10 lacked outer braces, 5 were fenced, 6 were shape-valid.
  Worker prompt now carries a positive envelope example and explicit
  negatives; the consumer strips one outer Markdown fence. 901 golden
  worker datums were built from teacher workflows + ground-truth bodies
  (268/272 train tasks teacher+golden green). Two more defects fixed on
  the way: defaulted parameters now render `?` in signatures, and the
  bridge splice pre-check honors the project tsconfig (project globals
  such as `TextEncoder` no longer fail it).
- **Mixed Stage 1**: 50/50 teacher-forced golden + on-policy KL per
  batch. 22/30 steps before the accounted-token budget gate stopped the
  run under the $3.50 cap (2,386,062 accounted tokens, worst-case
  $2.398); checkpoints at steps 5/10/15/20 (`stage1-mixed/`). Loss
  moved first 3682 → last 749 (batch-dependent sums).
- **Verification (step-20 checkpoint)**: forced-teacher with trained
  worker — body shape 19/19 valid (was 6/19), still 0/3 green; failures
  are now semantic (hallucinated local identifiers failing splice
  typecheck TS2552/2304). Canary with trained checkpoint in both roles —
  first canary worker dispatches ever: 2/10 episodes dispatched (16
  worker calls), 0/10 verified green. Targets (≥2/3 green;
  ≥3/10 dispatch + ≥1/10 green) were **not met**. Combined worst-case
  spend for the mixed run + verification ≈ $2.52 of the $3.50 cap.

## Envelope grounding + mixed continuation (run 2026-10-25)

- **Contract fix (R3-class)**: code worker envelopes now carry
  `local_declarations` — same-file exports and non-exports plus direct
  import bindings, each with exact name, kind, bounded signature, and
  line span. Signatures never include function or method bodies.
  Regression: an envelope-only scripted worker finds a non-exported
  `Record` table by declaration shape and resolves it to verified green.
- **Golden data**: worker datums rebuilt on grounded envelopes — 901
  datums including 228 real compile-error→correct-name shapes (mutated
  identifier, bridge TS2552 diagnostics, golden completion); 268/272
  train tasks teacher+golden green. Prefix-exact tokenization re-verified
  for orchestrator, worker, and error-shape datums.
- **Mixed continuation**: 15 further steps from the mixed step-20
  checkpoint before the budget gate (2,395,490 accounted tokens,
  worst-case $2.408); checkpoints at continuation steps 5/10/15.
- **Gates (step-15 checkpoint)**: forced-teacher with trained worker —
  **1/3 verified green** (first live-policy green; single worker call),
  other two settle completed with wrong bodies. Worker dispatches fell
  to 7 total (was 19). Canary with the checkpoint in both roles —
  **0/10 episodes dispatched, 0/10 green**; dominant diagnostics are
  `binding_failed` (no bound target), SHADOWED_FACADE/1184/1232 module
  code, and UNSAFE_HOLE_TYPE on the orchestrator side. Targets
  (≥2/3 green; ≥3/10 dispatch + ≥1/10 green) **not met**, so the
  one-step optimizer smoke in this sequence did not run. Round
  worst-case spend ≈ $2.49 of the $3.50 cap.

## Compile-boundary iteration (run 2026-10-25)

- **Diagnosis**: submitted workflows were teacher-shaped but failed on
  exact alias↔symbol pairing (student context listed Target aliases
  without their bound symbols), facade import lines, and repeated
  uncorrected submissions. Student prompts now carry explicit target
  bindings (`Target_i_j binds file#symbol`), the minimal prompt states
  the no-import/script-body rule, and 160 real compile-error recovery
  datums (import-poison, wrong-symbol, tool-namespace; real bridge
  diagnostics captured, teacher workflow as the correction) joined the
  golden mix.
- **Training**: mixed continuation from `stage1-mixed2` step-15 —
  13 steps, 104 on-policy + 376 golden datums, 2,498,647 accounted
  tokens (worst-case $2.511); checkpoints at continuation steps 5/10.
- **Gates (step-10 checkpoint) — both met**: forced-teacher with
  trained worker **2/3 verified green** (7→10 calls); canary with the
  checkpoint in both roles **7/10 episodes dispatched (37 worker
  calls), 2/10 verified green**, 0 infrastructure errors. One-step
  optimizer/checkpoint smoke from the verified checkpoint then passed
  (loss 75.2, reload + resample verified). Round worst-case spend
  ≈ $2.64 of the $3.50 cap.

## Stage 2 / Stage 3 RL (run 2026-10-25, live Tinker)

- **Shaping**: non-green partial credit now requires compile-clean +
  meaningful progress and `worker_calls >= 1`; `0.08` only for
  under-budget (`worker_calls < 8`) completed settlements, `0.02` for
  budget-exhausted or non-completed settlements, `0.0` for zero
  dispatches. Grouped RL (`6x6`, centered advantages) updates only on
  non-zero-advantage datums; no reference-KL loss exists in the loop, so
  the anchor is conservative LR `8e-5` (0.4x Stage 1). Spend caps are
  enforced by billing-class meters (uncached-prefill estimate; dated
  rates), not invoices.
- **Stage 2** (worker frozen at `stage1-mixed3/step-10`): 11 steps,
  budget stop before step 12, estimated spend $5.786 of $6; train
  dispatch 24–35 per 36-episode batch, stale episodes 0 throughout,
  2 infra-dropped episodes in step 1. Checkpoints `orch-step-5/10/11`.
  Canary (test offset 2, worker Mixed3): final step 11 — **6/10 sampled
  dispatch (5/9 receipt-scored; 1 context-budget infrastructure
  episode), 2/10 verified green, 0 stale**, worker calls
  `[0,0,0,8,0,2,4,8,6,8]`; selected step 10 — **8/10 dispatch, 3/10
  verified green, 0 stale**, worker calls `[0,0,1,8,8,2,2,8,6,8]`
  (43 total, $0.134). Step 10 is the Stage 2 winner (late-step drift at
  step 11). Artifacts: `zfacade-tinker/checkpoints/small/stage2/`,
  `runs/canary-stage2-step10/20261025T085443/`,
  `runs/canary-stage2-step11/20261025T084142/`.
- **Stage 3** (orchestrator from Stage 2 step 10, worker unfrozen from
  Mixed3 step 10): 12 steps, budget stop before step 13 (projected
  $6.065), estimated spend $5.596 of $6. Co-adaptation **regressed**:
  train pass rates 41%/67%/42%/39%/22% then 0%/8%/0%/0%/0%/0%/0%;
  steps 8–12 skipped both updates (zero advantage), so step-10/step-12
  checkpoints carry post-step-7 weights. Canaries (paired checkpoints):
  step 12 — **1/10 dispatch, 0/10 green**; step 5 (winner) — **5/10
  dispatch, 3/10 verified green, 0 stale**, worker calls
  `[0,0,1,1,8,2,6,0,0,0]` (18 total, $0.060). Artifacts:
  `zfacade-tinker/checkpoints/small/stage3/`,
  `runs/canary-stage3-step5/20261025T101956/`,
  `runs/canary-stage3-step12/20261025T101526/`.
- **34-task test evaluation** (Stage 3 step-5 pair, test split offset 0,
  sampling-only): **16/34 dispatch, 2/34 verified green (5.9%, Wilson
  95% 1.6–19.1%), 0 stale**, 95 worker calls, mean reward 0.057,
  estimated spend $0.342. Artifacts:
  `zfacade-tinker/runs/eval34-stage3-step5/20261025T102947/`.
- **Progression (10-task canary, same test offset 2)**: Base 0/10
  dispatch, 0/10 green → Stage 1 Mixed3 7/10, 2/10 → Stage 2 step 10
  8/10, 3/10 → Stage 3 step 5 5/10, 3/10 (same green with 18 vs 43
  worker calls, lower dispatch). Stale-revision (`stale_revision`
  settlement) count was 0 in every canary above; the earlier Mixed3
  canary file records cancelled 2/10, not stale settlements.

## Not ready / not run

- Stage 2 improved the canary; Stage 3 co-adaptation did not improve
  verified-green count and collapsed training dispatch after step 5.
  Capability remains narrow: best verified checkpoint is Stage 2
  `orch-step-10` with the Mixed3 worker (3/10 canary green); no
  checkpoint has been evaluated as a served local model, and A1 local
  CLI acceptance remains pending.
- A12 minority (credential-primary-path UI, network-command nuance, cloud
  branch) and A14–A18 unchanged; Linux unverified (seatbelt is macOS-only and
  fails closed elsewhere).
- CLI `run` remains unsandboxed trusted-skeleton execution under user grants;
  only bridge episodes (model-authored workflows) are seatbelt-confined.
