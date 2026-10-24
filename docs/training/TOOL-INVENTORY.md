# Agent tool inventory (G1 starter)

**Purpose:** training-environment toolkit catalog for zfacade episodes.  
**Status:** draft for expansion; not a freeze.  
**Related:** [ALIGNMENT.md](../ALIGNMENT.md) G1.

## 1. Design rule

Every listed tool must be one of:

1. **Implemented in zfacade** (`facade-agent` / effect admission), or
2. **Bundled binary** on the episode PATH, or
3. **Trusted host script** behind a capability (not policy-visible free bash).

Do not list aspirational tools. Absent tools stay absent (plan_prime Phase 2 rule).

## 2. Core facade tools (policy-visible)

| Name | Mutates | Notes |
| --- | --- | --- |
| Read | no | Canonical path + symlink checks |
| Write | yes | Grant required in headless |
| Edit | yes | Match-anchored replacement |
| ApplyPatch | yes | Unified diff |
| Bash | yes | Readonly classifier + grants; timeout; receipt |
| Grep | no | Prefer `rg` |
| Glob | no | |
| world.run / world-read | via engine | Training bridge effect path |

## 3. Native search stack

| Binary | Priority | Notes |
| --- | --- | --- |
| `rg` (ripgrep) | **bundle** | Universal agent default |
| `ugrep` | optional | ZCode backend |
| `bfs` | optional | ZCode breadth-first glob |
| `fd` | optional | Many agents; not in ZCode core |

Recommendation: bundle `rg` in the episode image; leave others as PATH extras.

## 4. Trusted host utilities (tinker tree)

| Path | Role |
| --- | --- |
| `zfacade-tinker/bin/zcode-sh-utils.sh` | Bounded slice/signature/text-impact helpers |
| `zfacade-tinker/tinker_recipe/local_tools.py` | Argv verification helpers |
| `zfacade-tinker/zcode_patch/compiler.mjs` | Offline AST audit/excision/hash-checked replace |

## 5. Scripts agents invent (patterns to standardize)

| Pattern | Standard form to offer |
| --- | --- |
| Search → replace | `rg -n` then Edit/ApplyPatch (never blind `sed -i` in training) |
| Move/rename | `git mv` + import fix helper |
| Run tests | `run-tests` wrapper: cwd, timeout, capture, receipt |
| Format/lint | `pnpm fmt` / `ruff` wrappers, non-zero = observation not crash |
| Build | `pnpm build` / `tsc --noEmit` gates |

## 6. Language scope (D11)

**TypeScript only.** Inventory and toolkit target TS projects (`tsc`, vitest).
Python / tree-sitter / multi-language generation is **struck** from the active plan
(ALIGNMENT G4 / D11). Do not advertise non-TS generation as supported.

## 7. Open items

- [ ] Freeze bundle list for the training image.
- [ ] Wire toolkit into episode `open` workspace bootstrap.
- [ ] Stress cases that require each bundled tool at least once.
