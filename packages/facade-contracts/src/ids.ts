import { randomUUID } from "node:crypto";
import { sha256Hex } from "./hash.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Stable workspace identity from a canonical (realpath-resolved) directory. */
export function workspaceKeyOf(canonicalPath: string): string {
  return sha256Hex(canonicalPath).slice(0, 32);
}

export const FACADE_VERSION = "0.1.0";
export const BRIDGE_PROTOCOL = 1;
