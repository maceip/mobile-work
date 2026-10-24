# zfacade alignment — training environment goals

**Date:** 2026-10-24  
**Audience:** all agents working on `~/zfacade` and `~/zfacade-tinker`  
**Status:** aligned with user intent this session. Supersedes silent drift in readiness-review scope.

---

## 1. What we are building (user goals)

A **training environment** that uses the zfacade facade to produce two things, then prove the system:

### G1 — Agent tool inventory and toolkit

Catalog and bundle the **working tools advanced coding agents actually use**:

- Binary/native helpers (e.g. bundled `ripgrep`, `ugrep`, `bfs`, `fd` — ZCode ships `native-search`).
- Scripts agents write for themselves: search, replace, move/rename, build, test, format, lint, patch apply.
- Host-side verification utilities already in the tinker tree (`bin/zcode-sh-utils.sh`, `local_tools.py`, `zcode_patch/compiler.mjs`).

Deliverable: a **tool inventory + bundled toolkit** the training step can ship with, not a vague list.

### G2 — Local stress proof of the upgrade

The upgrade is: **workflow compiler/execution layer is no longer an optional heavyweight “user asked for a workflow” path** (graph UI + approvals). It is the **main coding loop** — a coding agent whose code generation goes through the facade/engine.

Deliverable: local stress/suite runs that prove that inversion works (recovery, receipts, gates, worker envelopes) before any paid training.

### G3 — Live model first (OpenAI)

Before more extraction/feature work: put **OpenAI’s API** (highest quality available for shaking out bugs) into the **testing framework**. Local LLM serving stays deferred. Deterministic doubles remain for offline tests; they are not a substitute for live A1-style evidence.

### G4 — TypeScript only (decision 2026-10-24)

**Struck from the active track:** multi-language generation (Python AST / tree-sitter / dual compilers).

The facade and training corpus stay **TypeScript-only** for now. The workflow engine is the **coding loop / task-completion substrate** (asks, effects, receipts) — not a multi-language compiler suite. Do not add Python (or other) parse/typecheck/splice work until the user explicitly reopens G4.

| If needed later | Meaning |
| --- | --- |
| ~~A. TS orchestration only~~ | **This is the decision.** |
| B. Language-tagged artifacts | Deferred; not in scope. |
| C. Dual compilers / tree-sitter | Deferred; not in scope. |

Training tasks that would require non-TS source generation are **out of corpus** until G4 is reopened.

---

## 2. Scope fence (what “before we start to do anything” means)

**In scope immediately:**

1. This alignment doc (done).
2. **OpenAI in the testing framework** — config, canary, docs, how to run live tests (this turn).
3. Tool inventory draft (training-environment input; keep iterating).

**After OpenAI canary is green:**

4. Readiness-review **R1–R7** fixes (required before any paid Tinker training). R1/R2 are P0 and block training rewards and generated-code execution safety.
5. Stress suites for engine-owned loop (G2).
6. ~~Language decision (G4)~~ — **struck**; TypeScript only until explicitly reopened.
7. Only then Tinker sampling canary / training runs.

**Out of scope until explicitly pulled in:** local inference serving, marketplace, remote, REPL polish, Phase 2 memory/compaction productization.

---

## 3. Relationship to existing docs

| Doc | Role |
| --- | --- |
| `plan_prime.md` | Authoritative extraction/engine plan (D1–D9, E1–E6). Still binding on architecture. |
| `docs/DECISIONS.md` | Decision log. **D2 amended:** OpenAI hosted API is allowed as the *testing* provider (not Tinker, not local serving). |
| `docs/phase1/EVIDENCE.md` | Offline evidence. A1 still pending until live OpenAI canary is recorded. |
| `readiness-review.md` | NO-GO for paid training until R1–R7 fixed. Independent of G3. |
| `../zfacade-tinker/master_plan.md` | Training cookbook. Uses this runtime via `bridge_protocol.md`. |

---

## 4. OpenAI testing framework (this change)

- Provider kind **`openai`**: hosted `https://api.openai.com/v1` (or compatible), key from env (`apiKeyEnv`, default `OPENAI_API_KEY`). **Never** write keys into config or receipts.
- `openai-compatible` remains **loopback-only** (local servers). `deterministic-test` remains offline doubles.
- Live tests are **opt-in**: `pnpm test:live` / `node scripts/openai-canary.mjs`. Skipped when no key — never a silent pass.
- Live evidence is labeled `live-openai` in outputs so it cannot be confused with `deterministic-test`.

---

## 5. Tool inventory (starter — expand in G1)

### 5.1 Must ship (coding agent core)

| Tool | Role | Source today |
| --- | --- | --- |
| Read / Write / Edit / ApplyPatch | File mutation | zfacade `facade-agent` tools + ZCode handlers |
| Grep / Glob | Search | ZCode `search/` (rg/ugrep/bfs) |
| Bash (policy-gated) | Build/test/git | zfacade `sh-ops` + bash policy family |
| Path policy / protected paths | Safety | zfacade + ZCode `path-policy` |

### 5.2 Native binaries to bundle or require

| Binary | Used for |
| --- | --- |
| `ripgrep` (`rg`) | Fast content search (Claude Code, ZCode, Codex, Cursor-class agents) |
| `ugrep` / `bfs` | ZCode optional fast search backends |
| `git` | Diff, status, apply, history (almost universal) |
| `node` / language toolchains | Build/verify |

### 5.3 Scripts agents write or should be given

| Script class | Examples |
| --- | --- |
| Search/replace | `rg` + `sed`/`perl` one-shots; structured replace helpers |
| Move/rename | `git mv`, AST-aware rename |
| Build/test | `pnpm test`, `pytest`, `cargo test` wrappers with bounded timeout |
| Patch | unified diff apply, `apply_patch` |
| Verify | tinker `local_tools.py`, `zcode-sh-utils.sh`, `compiler.mjs` gates |
| Inspect | file hash, signature extract, slice extract |

### 5.4 Training-environment generation targets

1. **Inventory manifest** (machine-readable) + human README.
2. **Bundled toolkit dir** the episode workspace can rely on without inventing bash glue every time.
3. **Stress fixtures** that force tool use (search → edit → build → test) under the facade.

---

## 6. Non-negotiables (anti-drift)

1. **No paid Tinker training** until readiness R1–R7 are fixed and regressions exist.
2. **No claim of sandboxing** from `node:vm` or directory clones (readiness R2).
3. **No silent stubs** in the tool catalog for features that are absent.
4. **OpenAI is for testing/shakeout**, not the training optimizer path (Tinker owns that).
5. **Facade remains the only path** for model-directed generation and effects in training episodes.

---

## 7. Immediate checklist

- [x] Alignment written (`docs/ALIGNMENT.md`).
- [x] Config: `openai` provider kind (hosted) + keep local/deterministic kinds.
- [x] Live canary script + `pnpm test:live`.
- [x] DECISIONS.md amendment for OpenAI testing provider.
- [x] Tool inventory starter (`docs/training/TOOL-INVENTORY.md`).
- [x] Live canary green with `OPENAI_API_KEY` from `~/zfacade/.env` (2026-10-24, `gpt-4.1-mini`).
- [ ] Then R1–R7 / stress work.
