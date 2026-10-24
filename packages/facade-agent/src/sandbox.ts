import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ZfacadeError } from "@zfacade/contracts";

/**
 * R2 training-platform isolation: macOS seatbelt (sandbox-exec) profile.
 *
 * What the profile enforces (kernel, inherited by descendants):
 * - file writes confined to the episode workspace + episode temp/home;
 * - network denied outright;
 * - reads denied for credential/state locations (ssh/aws/gnupg keys, zfacade
 *   state, the tinker tree, repo .env).
 * What the profile does NOT prove: it is not a container or VM. World-readable
 * host files outside the deny list stay readable, and CPU/memory are bounded
 * only by wall-clock timeout + process-group kill. Full OS isolation (plan
 * A14) remains open. Absence of sandbox-exec fails closed.
 */
export interface SandboxSpec {
  profilePath: string;
  workspace: string;
  tmpDir: string;
  homeDir: string;
  rootDir: string;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function sbplString(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildSeatbeltProfile(input: {
  workspace: string; tmpDir: string; homeDir: string; denyRead: string[];
}): string {
  const writable = [input.workspace, input.tmpDir, input.homeDir];
  const writeDeny = [
    "(deny file-write*",
    "  (require-all",
    ...writable.map((p) => `    (require-not (subpath ${sbplString(p)}))`),
    `    (require-not (literal "/dev/null"))`,
    `    (require-not (literal "/dev/stdout"))`,
    `    (require-not (literal "/dev/stderr"))`,
    `    (require-not (subpath "/dev/fd"))))`,
  ].join("\n");
  const readDeny = input.denyRead
    .map((p) => `(deny file-read* (subpath ${sbplString(p)}))`)
    .join("\n");
  const readAllow = writable
    .map((p) => `(allow file-read* (subpath ${sbplString(p)}))`)
    .join("\n");
  return ["(version 1)", "(allow default)", "(deny network*)", readDeny, readAllow, writeDeny, ""].join("\n");
}

/** Real account home from the passwd entry — $HOME is attacker/test-controlled. */
function realHome(): string {
  try { return userInfo().homedir; } catch { return homedir(); }
}

function defaultDenyRead(): string[] {
  const home = realHome();
  // Datasets/solutions/state/credentials only. Toolchain trees (node_modules
  // with tsc etc.) stay readable: pinned gate argv legitimately references them.
  const candidates = [
    join(home, ".ssh"), join(home, ".aws"), join(home, ".gnupg"),
    join(home, ".zfacade"), join(home, "zfacade-tinker", "data"),
    join(home, "zfacade-tinker", "checkpoints"),
    join(home, ".config", "gh"),
    ...(process.env.ZFACADE_HOME ? [process.env.ZFACADE_HOME] : []),
  ];
  return candidates.filter((p) => existsSync(p)).map((p) => realpathSync(p));
}

function credentialFiles(): string[] {
  const home = realHome();
  return [join(home, "zfacade", ".env"), join(home, "zfacade-tinker", ".env")]
    .filter((p) => existsSync(p)).map((p) => realpathSync(p));
}

/** Create an episode sandbox and prove the boundary with live probes. Throws when unavailable. */
export function createEpisodeSandbox(workspace: string): SandboxSpec {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) {
    throw new ZfacadeError("SandboxUnavailable",
      "macOS sandbox-exec is required for bridge episode isolation and is not available; refusing to run generated code unsandboxed");
  }
  const rootDir = mkdtempSync(join(tmpdir(), "zfacade-sbx-"));
  const tmpDir = join(rootDir, "tmp");
  const homeDir = join(rootDir, "home");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const spec: SandboxSpec = {
    profilePath: join(rootDir, "profile.sb"),
    workspace: realpathSync(workspace),
    tmpDir: realpathSync(tmpDir),
    homeDir: realpathSync(homeDir),
    rootDir,
  };
  const denyRead = [...defaultDenyRead()];
  const literalDenies = credentialFiles()
    .map((p) => `(deny file-read* (literal ${sbplString(p)}))`)
    .join("\n");
  writeFileSync(spec.profilePath, buildSeatbeltProfile({
    workspace: spec.workspace, tmpDir: spec.tmpDir, homeDir: spec.homeDir, denyRead,
  }) + (literalDenies ? literalDenies + "\n" : ""));
  // Probes: benign command runs; write outside the workspace is denied.
  const ok = spawnSync(SANDBOX_EXEC, ["-f", spec.profilePath, "/usr/bin/true"], { timeout: 10_000 });
  if (ok.status !== 0) {
    rmSync(rootDir, { recursive: true, force: true });
    throw new ZfacadeError("SandboxUnavailable", `sandbox-exec self-test failed: ${ok.stderr?.toString().slice(0, 300) ?? ok.status}`);
  }
  const outside = join(rootDir, "..", `zfacade-sbx-probe-${process.pid}.txt`);
  const probe = spawnSync(SANDBOX_EXEC, ["-f", spec.profilePath, process.execPath, "-e",
    `require("fs").writeFileSync(${JSON.stringify(outside)}, "probe")`], { timeout: 10_000 });
  const escaped = existsSync(outside);
  if (escaped) rmSync(outside, { force: true });
  if (probe.status === 0 || escaped) {
    rmSync(rootDir, { recursive: true, force: true });
    throw new ZfacadeError("SandboxUnavailable", "sandbox profile did not confine writes; refusing to run generated code");
  }
  return spec;
}

export function wrapArgv(spec: SandboxSpec, argv: string[]): string[] {
  return [SANDBOX_EXEC, "-f", spec.profilePath, ...argv];
}

export function sandboxEnv(spec: SandboxSpec): Record<string, string> {
  return { HOME: spec.homeDir, TMPDIR: spec.tmpDir };
}

export function destroySandbox(spec: SandboxSpec): void {
  rmSync(spec.rootDir, { recursive: true, force: true });
}
