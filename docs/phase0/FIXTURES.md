# Phase 0 boundary fixtures

Fixtures live under `fixtures/` and are consumed by maintained vitest suites in
each package. Deterministic doubles appear only in tests (plan §10); fixture
passes are never labeled live-provider evidence.

| Fixture | Purpose | Consumed by |
| --- | --- | --- |
| `fixtures/repos/failing-test/` | Disposable repo with one failing test + one-line source fix (A1 shape, double-driven) | facade-agent step tests, bridge acceptance 1 |
| `fixtures/workflows/inspect-only.ts` | Workflow using only files/git reads; zero synthesis holes (bridge acceptance 3) | bridge tests |
| `fixtures/workflows/typed-leaf.ts` | Workflow with one `hole<T>` code leaf over an exported function | bridge acceptance 1, 4, 6 |
| `fixtures/workflows/ask-data.ts` | Typed `ask<T>` requiring data envelope; wrong-JSON rejection (bridge acceptance 2) | bridge tests |
| `fixtures/workflows/subgraph.ts` | Hole filled by validated flat subgraph expansion (bridge acceptance 5) | bridge tests |
| `fixtures/workflows/world-run.ts` | `world.run` command node for replay/hold tests (A3 shape) | recovery tests |
| `fixtures/provider/fix-script.json` | Deterministic provider script: read → edit → bash test → done (labeled test double in every receipt) | facade-agent tests |
| `fixtures/bridge/episode.json` | Example `open` params (gates, protected files, limits) matching tinker `env.py` call shape | bridge tests |

Crash fixtures (A3 deterministic subset): tests kill settlement at four points —
before dispatch, after dispatch, after file effect, after receipt commit — by
injecting faults at EffectService seams, then reopen the store and assert:
completed effects never rerun, ambiguous effects hold as `outcome_unknown`,
committed receipts repair projections exactly once. Process-kill of the real CLI
(mid-Bash) is covered by an integration test spawning the built CLI.

Permission fixtures (A7 subset): no-grant Edit/Bash => durable pending + exit 2;
changed argv/cwd after grant => fresh denial; protected test file write =>
`policy_violation`; traversal/symlink escape => denial with reason (A12 subset).
