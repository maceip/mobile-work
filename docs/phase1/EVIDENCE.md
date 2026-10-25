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

## Not ready / not run

- Gate 5 (inspect canary evidence, then one-step optimizer/checkpoint
  smoke) awaits explicit go/no-go. No optimizer update has ever run.
- No live policy (OpenAI or Tinker) has produced a verified-green bridge
  episode yet; base models do not know the facade zero-shot.
- A12 minority (credential-primary-path UI, network-command nuance, cloud
  branch) and A14–A18 unchanged; Linux unverified (seatbelt is macOS-only and
  fails closed elsewhere).
- CLI `run` remains unsandboxed trusted-skeleton execution under user grants;
  only bridge episodes (model-authored workflows) are seatbelt-confined.
