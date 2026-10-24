# zfacade

Standalone CLI coding agent extracted from ZCode. The workflow compiler/engine
owns the coding loop; tools, permissions, and durable receipts run locally.

Status: Phase 0 complete. Phase 1 engine/tools/permissions/persistence/recovery
and the training runtime bridge are implemented and tested with deterministic
doubles. The local-provider A1 acceptance gate is pending (no Phase 1
acceptance claimed). See [EVIDENCE.md](./docs/phase1/EVIDENCE.md).

- Authoritative plan: [plan_prime.md](./plan_prime.md)
- Decisions: [DECISIONS.md](./docs/DECISIONS.md), [Phase 0](./docs/phase0/FREEZE.md)
- Upstream: `/Users/mac/ZCode` @ `042d4f6a…` (vendored under `vendor/zcode-core/`)
- Bridge: `zfacade bridge` (protocol v1, NDJSON over stdio) for zfacade-tinker

```bash
# Node 24.14.0 (nvm) + pnpm 10.33.2 (Corepack)
pnpm install
pnpm -r --sort build
node packages/facade-cli/dist/main.js --help
```
