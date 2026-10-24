# Phase 0 freeze (2026-10-24)

Immutable baselines. Builds and parity tests must reference these values, never
a dynamically resolved HEAD (plan_prime §2).

| Item | Frozen value |
| --- | --- |
| plan_prime.md SHA-256 | `d401a2461e73eb08b0f529f238150345a7c253339e2837d20fdf18ec6d901c80` |
| ZCode checkout | `/Users/mac/ZCode` @ `042d4f6a36ceb9c96f30f4d955d23b8fe75e3b11` (clean; `main` ahead 1 of origin) |
| ITE checkout (read-only) | `/Users/mac/interactive-task-engine` @ `87b16e73c6c2ee0ddcc23b8b85b1255bbd1c2603` (dirty paths excluded; Git objects only) |
| ITE provenance upstream | ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e`, extraction `a3d4e2813c583e5a7382f3a61ffb615948060079` |
| Node | `24.14.0` (nvm, user-local; `.nvmrc` pins the same) |
| pnpm | `10.33.2` (Corepack; root `packageManager` pins the same) |
| TypeScript | `^5.9.0` (upstream dynamic-workflow dependency) |
| Test runner | `vitest ^4.1.5` (upstream devDependency; runs vendored contract suites) |
| Platform verified | macOS 27.0.1 arm64 (Darwin 27.0.0). Linux unverified. Windows unsupported. |
| ripgrep | `rg 15.1.0` at `/opt/homebrew/bin/rg` (required for Grep; missing-rg behavior tested) |
| SQLite | `node:sqlite` `DatabaseSync` on Node 24.14.0 (verified in-process); CLI `sqlite3 3.50.6` present for inspection |
| ZCode LICENSE SHA-256 | `606c36baf38b973227273df12a74930e4b4137280eea835c5cd623aa4553c13b` (Apache-2.0) |
| ZCode NOTICE.md SHA-256 | `6bd5e85b48a192ce100a9e5e0636e3a90d3f6e1ac1c4fe74369e13bd79bb4c45` |

Network boundary (plan §3.2): coordinator, state, and tools are local. No
telemetry, update, marketplace, remote host, relay, or cloud sync code is
vendored. Model endpoint access is a configured capability (live gate pending
under S4). Bash may invoke network-capable programs only under explicit grant;
no offline claim is made.

Vendored file inventory with original/destination SHA-256 per file is generated
by `scripts/vendor-provenance.mjs` into `vendor/zcode-core/PROVENANCE.json` at
vendor time and re-verified by tests. Generated compiler assets
(`src/compiler/libs.generated.ts`) are build outputs of
`scripts/generate-libs.mjs`, excluded from provenance originals and listed as
generated in PROVENANCE.json.
