#!/usr/bin/env node
// Regenerates vendor/zcode-core/PROVENANCE.json: per-file origin/destination
// SHA-256 against the frozen ZCode baseline working tree (verified clean).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ZCODE = "/Users/mac/ZCode";
const ZCODE_REV = "042d4f6a36ceb9c96f30f4d955d23b8fe75e3b11";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const VENDOR = join(ROOT, "vendor/zcode-core");

const ADAPTATIONS = new Map([
  ["packages/dynamic-workflow/src/engine/engine-world.ts",
   "E2a: running world-run replay settles OutcomeUnknown hold (plan 5.3); E2b: pass world context to driver"],
  ["packages/dynamic-workflow/src/engine/types.ts",
   "E2b: WorkflowDriver.executeWorldRead optional WorldOpContext parameter"],
  ["packages/dynamic-workflow/src/engine/errors.ts",
   "E2a: OutcomeUnknown error code for ambiguous-effect holds"],
  ["packages/dynamic-workflow/src/engine/index.ts",
   "E2b: export WorldOpContext type"],
  ["packages/dynamic-workflow/src/index.ts",
   "E2b: re-export WorldOpContext type at package root"],
  ["packages/dynamic-workflow-runtime/src/harness.ts",
   "E2c: minimal explicit child environment allowlist; Electron env branch removed (plan 6.2). E8: optional spawnWrapper (seatbelt) around VM child"],
  ["packages/dynamic-workflow-runtime/tests/child-spawn-env.test.ts",
   "E2c deviation test: assert allowlist env, no inherited canary/secret"],
  ["packages/dynamic-workflow-runtime/tests/child-spawn-args.test.ts",
   "E2c deviation test: assert no ELECTRON_RUN_AS_NODE on both spawn strategies"],
  ["packages/dynamic-workflow/src/facade/registry.ts",
   "E7: sh.* training world ops (z-sig/z-slice/z-impact/z-verify)"],
  ["packages/dynamic-workflow/src/facade/dts.ts",
   "E7: splice FACADE_SH_SEGMENT into full facade"],
  ["packages/dynamic-workflow/tests/facade-dts.test.ts",
   "E7 deviation test: facade hash includes sh segment"],
]);
const GENERATED = new Set(["packages/dynamic-workflow/src/compiler/libs.generated.ts"]);
const ADDED = new Set(["scripts/clean-dist.mjs", "packages/dynamic-workflow/src/facade/dts-sh.ts"]);

function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }
function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "dist" && name !== "node_modules") walk(p, out); }
    else out.push(p);
  }
  return out;
}

const entries = [];
for (const file of walk(VENDOR)) {
  const rel = relative(VENDOR, file);
  if (rel === "PROVENANCE.json") continue;
  const destHash = sha256(readFileSync(file));
  if (ADDED.has(rel)) { entries.push({ dest: rel, destSha256: destHash, class: "added" }); continue; }
  if (GENERATED.has(rel)) { entries.push({ dest: rel, destSha256: destHash, class: "generated", by: "scripts/generate-libs.mjs" }); continue; }
  const originRel = rel.startsWith("packages/") ? `apps/zcode-cli/${rel}` : rel;
  const originPath = join(ZCODE, originRel);
  if (!existsSync(originPath)) { entries.push({ dest: rel, destSha256: destHash, class: "added-unmapped" }); continue; }
  const originHash = sha256(readFileSync(originPath));
  const same = originHash === destHash;
  entries.push({
    dest: rel, origin: originRel, originSha256: originHash, destSha256: destHash,
    class: same ? "copy" : "adapted",
    ...(same ? {} : { reason: ADAPTATIONS.get(rel) ?? "UNRECORDED ADAPTATION" }),
  });
}
const unrecorded = entries.filter((e) => e.reason === "UNRECORDED ADAPTATION" || e.class === "added-unmapped");
const doc = {
  upstream: { repo: ZCODE, revision: ZCODE_REV },
  license: "Apache-2.0 (see LICENSE, NOTICE.md in this directory)",
  counts: {
    total: entries.length,
    copy: entries.filter((e) => e.class === "copy").length,
    adapted: entries.filter((e) => e.class === "adapted").length,
    generated: entries.filter((e) => e.class === "generated").length,
    added: entries.filter((e) => e.class.startsWith("added")).length,
  },
  entries,
};
writeFileSync(join(VENDOR, "PROVENANCE.json"), JSON.stringify(doc, null, 2) + "\n");
console.log(`provenance: ${JSON.stringify(doc.counts)}`);
if (unrecorded.length > 0) {
  console.error("UNRECORDED adaptations:", unrecorded.map((e) => e.dest).join(", "));
  process.exit(1);
}
