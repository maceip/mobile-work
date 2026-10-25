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

## Not ready / not run

- Stage 2/3 (RL through the bridge) not run; needs separate go and
  budget. No live policy has produced a verified-green bridge episode
  yet, trained or base.
- A12 minority (credential-primary-path UI, network-command nuance, cloud
  branch) and A14–A18 unchanged; Linux unverified (seatbelt is macOS-only and
  fails closed elsewhere).
- CLI `run` remains unsandboxed trusted-skeleton execution under user grants;
  only bridge episodes (model-authored workflows) are seatbelt-confined.
