import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ZfacadeError } from "@zfacade/contracts";

/** Segments that never name a legitimate tool target inside a workspace. */
export const PROTECTED_SEGMENTS = new Set([".git"]);

export function canonicalRoot(dir: string): string {
  return realpathSync(resolve(dir));
}

function reject(reason: string): never {
  throw new ZfacadeError("PathDenied", reason);
}

/** Lexical checks first (tinker contracts.relative_path parity), then filesystem enforcement. */
export function assertSafeRelative(rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) reject("path must be a non-empty string");
  if (rel.includes("\0")) reject(`path contains NUL: ${JSON.stringify(rel)}`);
  if (rel.includes("\\")) reject(`path must use forward slashes: ${rel}`);
  if (isAbsolute(rel)) reject(`path must be workspace-relative: ${rel}`);
  const parts = rel.split("/");
  if (parts.some((p) => p === ".." || p === "")) reject(`path escapes workspace: ${rel}`);
  if (parts.some((p) => PROTECTED_SEGMENTS.has(p))) reject(`path enters protected segment: ${rel}`);
  return rel;
}

/**
 * Resolve a workspace-relative path to an absolute target, enforcing that every
 * existing ancestor (and the target itself when present) stays inside the
 * canonical root after symlink resolution. Missing write targets are checked
 * through their nearest existing ancestor. Returns absolute path.
 */
export function resolveInside(root: string, rel: string): string {
  assertSafeRelative(rel);
  const absRoot = canonicalRoot(root);
  const target = join(absRoot, ...rel.split("/"));
  let probe = target;
  while (!existsSync(probe)) {
    const parent = resolve(probe, "..");
    if (parent === probe) reject(`no existing ancestor inside workspace: ${rel}`);
    probe = parent;
  }
  const realProbe = realpathSync(probe);
  if (realProbe !== absRoot && !realProbe.startsWith(absRoot + sep)) {
    reject(`symlink escapes workspace: ${rel} -> ${realProbe}`);
  }
  // A symlinked final component pointing outside is rejected even for reads;
  // in-workspace symlinks are allowed only when the resolved target stays inside.
  if (probe === target && lstatSync(target).isSymbolicLink()) {
    const realTarget = realpathSync(target);
    if (realTarget !== absRoot && !realTarget.startsWith(absRoot + sep)) {
      reject(`symlink target escapes workspace: ${rel}`);
    }
    return realTarget;
  }
  return target;
}

export function toRelative(root: string, absPath: string): string {
  const rel = relative(canonicalRoot(root), absPath).split(sep).join("/");
  if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) reject(`path outside workspace: ${absPath}`);
  return rel;
}
