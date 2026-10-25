# Gate 3–5 decisions (for the readiness/training agent)

**From:** zfacade coordination session, 2026-10-24  
**User standing rules:** always commit without asking (D4 superseded); quality-first not thrift (D12); big model = OpenAI (D13); small train = Qwen3.5-4B (D14); live OpenAI = gpt-5.5 (D15).

## 1. Gate 3 corpus source — DECIDED

**Blend**, not ZCode mining:

| Source | Role |
| --- | --- |
| `/Users/mac/hunk` | Primary local mining (MIT, 890 commits, strong tests) |
| `/Users/mac/vivari` | Secondary local (after spot-check) |
| Multi-SWE-bench **TypeScript** slice | Public fail-to-pass (cloned at `zfacade-tinker/data/public/multi-swe-bench`, 322 TS harness files; HF `ByteDance-Seed/Multi-SWE-bench` `ts/*` jsonl) |
| Optional fillers | SWE-smith / R2E-Gym TS if volume short |

**Do not mine:** ZCode/ITE (squash dumps), avery*, Vulcan, OpenOpenInstinct spam, accountbox Gmail traces.

Manifest: `zfacade-tinker/data/corpus_plan.json`. Target ≥200 tasks + disjoint holdouts. Every task: green-before / red-after (or real bugfix red→green) under seatbelt verification.

## 2. Gate 4 canary — DECIDED

| Setting | Value |
| --- | --- |
| Experiment | `small-4b` |
| Orchestrator | `Qwen/Qwen3.5-4B` |
| Worker | `Qwen/Qwen3.5-4B` |
| Mode | sampling-only, **0 optimizer updates** |
| Tasks | **10** fixed (from Gate 3 holdout-style slice) |
| Caps | ≤50 worker calls, ≤2M completion tokens, **≤$50** hard abort |
| Workhorse track | `Qwen/Qwen3.6-35B-A3B` + frozen 4B worker (not used for Gate 4) |

Caps are **safety aborts**, not cost minimization (D12). Fill `bridge_command` as already in `configs/small.json`. Full-training configs stay broader; do not run them for canary.

## 3. Gate 5 — PROCESS CONFIRMED

Present **real canary transcripts + receipts** first. Separate go/no-go before the one-step optimizer/checkpoint smoke. Do **not** treat Gate 4 as Gate 5 approval.

## 4. OpenAI bridge-policy shakeout — YES

Before Gate 4 Tinker spend, run **1–2 OpenAI `gpt-5.5` episodes through the bridge** (not just CLI canary) for live policy evidence. User supplied OpenAI key; D13/D15.

## 5. Commits — ALWAYS

**D4 “no commits until asked” is superseded.** Always commit accepted work in `~/zfacade` and `~/zfacade-tinker`. Latest zfacade: `512f720` (R1–R7 + OpenAI gpt-5.5). Latest tinker: `719b0aa` (small-4b pin). Never commit `.env` / keys.

## What you can do now

1. Build production `data/local/zcode_tasks.jsonl` from the blend above (or map Multi-SWE-bench TS → task schema in `tinker_recipe/dataset.py` / `contracts.py`).
2. Fill any remaining `bridge_command` / limits in configs from this table.
3. Run OpenAI gpt-5.5 bridge-policy shakeout (1–2 tasks).
4. Run Gate 4 sampling-only canary with the caps above.
5. **Stop** and present transcripts/receipts for Gate 5 go/no-go.
