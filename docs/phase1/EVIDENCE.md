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

## Not ready / not run

- No live **policy** evidence through the training bridge (scripted doubles
  only). No Tinker call, paid or otherwise, ran in the fix pass.
- Acceptance gates 3–5 pending explicit approval: corpus replay with
  host-private reference repairs, bounded sampling-only canary (zero optimizer
  updates), one-step optimizer smoke.
- A12 minority (credential-primary-path UI, network-command nuance, cloud
  branch) and A14–A18 unchanged; Linux unverified (seatbelt is macOS-only and
  fails closed elsewhere).
- CLI `run` remains unsandboxed trusted-skeleton execution under user grants;
  only bridge episodes (model-authored workflows) are seatbelt-confined.
