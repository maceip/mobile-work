#!/usr/bin/env node
// Package-direction and cut-surface checks (plan 8.2/8.4).
// Fails on forbidden imports, deep cross-package paths, or excluded packages.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const RULES = [
  { from: "packages/facade-contracts/src", allow: [/^node:/, /^\./], deny: [/^@zfacade\//, /^@zcode\//] },
  { from: "packages/facade-core/src", allow: [/^node:/, /^\./, /^@zfacade\/contracts$/, /^@zcode\/dynamic-workflow$/] },
  { from: "packages/facade-agent/src", allow: [/^node:/, /^\./, /^@zfacade\/(contracts|core)$/, /^@zcode\/dynamic-workflow(-runtime)?$/, /^typescript$/] },
  { from: "packages/facade-cli/src", allow: [/^node:/, /^\./, /^@zfacade\/(contracts|core|agent)$/, /^@zcode\/dynamic-workflow$/, /^typescript$/] },
];
const EXCLUDED = ["electron", "playwright", "playwright-core", "koffi", "cheerio", "@modelcontextprotocol", "telemetry"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== "dist") walk(p, out); }
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

let failures = 0;
for (const rule of RULES) {
  for (const file of walk(join(ROOT, rule.from))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      if (EXCLUDED.some((x) => spec === x || spec.startsWith(x + "/"))) {
        console.error(`EXCLUDED ${file} -> ${spec}`); failures++;
      }
      if (rule.deny?.some((re) => re.test(spec))) {
        console.error(`DENIED ${file} -> ${spec}`); failures++; continue;
      }
      if (!rule.allow.some((re) => re.test(spec))) {
        console.error(`BOUNDARY ${file} -> ${spec}`); failures++;
      }
    }
  }
}
console.log(failures === 0 ? "boundaries: ok" : `boundaries: ${failures} violation(s)`);
process.exit(failures ? 1 : 0);
