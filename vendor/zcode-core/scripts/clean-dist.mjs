#!/usr/bin/env node
// Local replacement for the upstream monorepo clean helper referenced by
// vendored package.json "clean" scripts (../../scripts/clean-dist.mjs).
import { rmSync } from "node:fs";
import { join } from "node:path";
rmSync(join(process.cwd(), "dist"), { recursive: true, force: true });
