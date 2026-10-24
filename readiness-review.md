# Training readiness review — 2026-10-24

**Decision: NO-GO for paid training against the present contract/runtime.**

This is a bounded, independent audit of the training bridge and its consumer, not a complete review of the extraction. No Tinker calls, sampling, optimizer steps, model downloads or serving changes were made. Repository source and configuration were not edited. Reproduction scripts, disposable Git repositories, SQLite state, fixtures and evidence are under temporary directories.

## What was independently run

- Pinned Node 24.14.0, existing built CLI.
- Existing `facade-cli` bridge and transform suites: 2 files, 10 tests passed (7 real-process bridge cases plus 3 transform cases).
- Nine targeted bridge probes: 8 reached their intended conditions; the initial empty-ref cancellation setup returned compile_error, so cancellation was repeated with the existing ask-data fixture and confirmed separately.
- Two complete calls to the unchanged `tinker_recipe.env.episode`, using a task produced by the real miner, the unchanged Python `FacadeBridge`, the real CLI/SQLite/tools, and explicitly scripted orchestrator/worker doubles with synthetic token traces. The valid repair and repair-then-invalid-gate both received reward **0.999998**.
- The reported 1,983 + 98 vendored tests and other facade suites were not rerun in this audit. Their counts cannot establish the missing bridge invariants.

## Findings and required fixes

### R1 — P0: invalid workflow outcomes become successful training rewards

`packages/facade-cli/src/bridge.ts:645` computes `verified_green` without requiring a completed settlement, then discards `status` at line 649. `cancel()` clears pending requests before computing the receipt. `tinker_recipe/env.py:75` and `contracts.py:138` trust the resulting success flags without checking workflow settlement or pending/cancelled effects.

Observed:

- An unregistered gate on a passing workspace returned `status: errored`, `verified_green: true`, `policy_violation: false`.
- Cancelling a parked askData request on a passing workspace returned `status: cancelled`, `verified_green: true`, `no_unresolved_holes: true`.
- Starting from a genuinely broken task, repairing it and then calling an unregistered gate received the same 0.999998 reward as the valid repair through the actual Python episode environment.

Required: define and enforce one explicit terminal-success predicate in bridge and consumer; retain unresolved/cancelled work in receipts; classify denied policy operations; reject inconsistent status/receipt pairs before scoring. Add regressions for success followed by failure/denial, cancellation with pending work, timeouts, and unknown effect outcomes. Independent final tests do not erase workflow violations.

### R2 — P0: generated source runs outside the effect permission boundary

The code-splice write is admitted, but the test process subsequently executes arbitrary worker-generated source directly on the host. `packages/facade-agent/src/tools.ts:412` launches that verifier with ordinary host filesystem access. A directory clone and stripped environment are not that isolation boundary.

Observed: a replacement function used `Function("return process")().getBuiltinModule("fs")` to write a harmless sentinel outside the episode workspace. The bridge returned `verified_green: true`, `policy_violation: false`, and `tests_unchanged: true`. Only a temporary review sentinel was touched; no credentials or user files were accessed.

Required before generated-code training execution: run verification and generated workflows under an enforced isolation boundary for the training platform, with writable episode scope, protected evaluator inputs, inaccessible host datasets/credentials/state, bounded processes and controlled network. Add benign outside-path, test-tampering, descendant-process and resource-limit regressions. This is separate from the deferred local model server. Do not solve it with a keyword filter or a claim that node:vm is a sandbox.

### R3 — P1: the worker is missing the contract/context needed to solve tasks

`packages/facade-cli/src/bridge.ts:275` sends `type_declaration: envelope.typeText`, which can be only an alias name. It sends file hashes but no associated source/signature text, resolved alias definitions, imports, public task root specification or relevant test evidence. The fresh worker in `tinker_recipe/env.py` receives only its system prompt and this request.

Observed: the existing typed-leaf shape produced `type_declaration: "Sum"`, `instructions: "Implement sum"`, a target ID and hashes. It did not supply the definition of Sum or the actual target parameter names. The scripted worker knows `left` and `right` from test code outside the request, masking this gap. The data-request path also omits scoped refs/root context.

Required: construct immutable, self-contained worker envelopes with resolved types, actual target declaration/signature and parameter bindings, needed imports/symbol snippets, root task specification, scoped public evidence and hashes. Verify sufficiency with a worker that receives only that envelope. Do not expose inverse patches or hidden evaluator solutions.

### R4 — P1: askCode<T> does not enforce T against its target

The transform replaces the code ask's return contract with `__ZfCodeResult`; `applyCodeLeaf` checks the replacement against the existing file but never establishes compatibility between the declared T and the bound target. It also permits omitted target identity/hash via fallbacks (`bridge.ts:384,393`).

Observed: `askCode<(text: string) => boolean>` targeting `sum(left:number,right:number):number` accepted `{ return left + right; }` and returned verified green.

Required: bind exactly the intended target and check the stated code contract against its project-resolved type before dispatch/application. Require identity/hash fields, reject stale refs and ambiguous bindings, and preserve CodeArtifact<T> semantics. The type-directed research objective requires this contract to be real.

### R5 — P1: advertised subgraphs do not execute the proposed subgraph

`bridge.ts:447` ignores the submitted source and top-level root_digest, validates child obligation lists, reorders existing targets, and increments a depth counter. It does not compile or insert the proposed child source into the root graph. The original parent obligations remain unchanged across repeated expansion.

Observed: source `THIS IS NOT VALID TYPESCRIPT !!!` with top-level `root_digest: wrong-root` was accepted twice, with the same full obligations returned on both requests and a host message saying the subgraph was validated.

Required: implement actual source validation, root anchoring, child-node creation, parent composition and strictly decreasing child obligations, with graph/receipt evidence; or fail closed and explicitly remove this capability and related training tasks/prompts from an agreed narrower pilot. Do not present target sequencing as completed subgraph support or increase depth without actual graph expansion.

### R6 — P1: stale verification observations change successor control flow

`bridge.ts:570` computes an invalidation count but does not pass the invalidated set to cache filtering. `buildImportedCache` imports completed world reads/runs, including z_verify. Fresh final verification protects only final file-state checks; it cannot repair decisions already made from a stale result.

Observed: revision 0 returned a failing gate result. Revision 1 repaired the source, then replayed the old failing z_verify observation and threw `GATE_OBSERVATION_FAILURE`. Fresh final tests passed, so the same response was `status: errored`, `verified_green: true`, `reused_nodes: 2`, `invalidated_nodes: 2`.

Required: invalidate observations and downstream decisions using actual dependency and workspace/evaluator identities. Retain historical effect receipts without treating old test outcomes as current. Add fail-to-pass and pass-to-fail amendment cases, an independent sibling reuse case, and no-duplicate-write assertions. The quoted judgment call is not acceptable as currently implemented.

### R7 — P1: compiler feedback is discarded

`bridge.ts:655` uses `.map(String)` on diagnostic objects.

Observed: `const broken: number = "x"; return broken;` returned `diagnostics: ["[object Object]"]`.

Required: return bounded structured diagnostic code/message/location data. Test the real Python observation path. Compiler-feedback training needs actionable compiler feedback.

## Evidence paths and reproduction

Scripts:

- `/tmp/zfacade-bridge-review-20261024.py`
- `/tmp/zfacade-bridge-review-extra-20261024.py`
- `/tmp/zfacade-training-env-review-20261024.py`

Run any script with `/Users/mac/zfacade-tinker/.venv/bin/python`. Each creates disposable local fixtures/state and prints its artifact directory. These scripts are offline reviews; do not add Tinker credentials or change them into model calls.

Recorded outputs:

- `/var/folders/8j/5mwkcdz55xbcg1pg_54tlcf00000gn/T/zfacade-review-5iwf0xbi/results.json`
- `/var/folders/8j/5mwkcdz55xbcg1pg_54tlcf00000gn/T/zfacade-review-6al9czzi/results.json`
- `/var/folders/8j/5mwkcdz55xbcg1pg_54tlcf00000gn/T/zfacade-env-review-_o5atzcs/results.json`

Existing suites rerun:

```sh
cd /Users/mac/zfacade/packages/facade-cli
/Users/mac/.nvm/versions/node/v24.14.0/bin/node node_modules/vitest/vitest.mjs run tests/bridge.test.ts tests/transform.test.ts
```

## Required readiness gates

1. Fix R1–R7 and preserve reproductions as maintained regression tests with exact expected outcomes. Update EVIDENCE.md to withdraw overstated acceptance claims and distinguish scripted bridge workers from live workers.
2. Freeze the intended supported training contract. Exercise the actual dataset → episode workspace → native tool messages → real bridge → worker envelope → verification → reward → loss-datum path offline. Include valid repairs, wrong bodies, compilation/schema errors, malformed/truncated replies, amendments, cancellation, timeouts and forbidden effects. Infrastructure failures must not become policy rewards.
3. Replay the selected corpus with host-private reference repairs to prove task/environment compatibility. Keep reference solutions out of policy-visible inputs. Run overlap/leakage and baseline/broken/restored checks; preserve source checkouts.
4. Only after offline readiness, use a separately bounded Tinker sampling-only integration canary with a fixed small task list, token/request cap, zero optimizer updates and no automatic escalation into full training. This verifies the service/renderer path that offline doubles cannot prove.
5. Inspect the real canary transcripts and receipts. Then perform a bounded one-step optimizer/checkpoint smoke before any full experiment. No full paid run should be used to discover the defects above.

Local inference serving remains deferred. It is unrelated to these training-runtime correctness defects.

