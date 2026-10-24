import { createHash } from "node:crypto";

/** Stable JSON: object keys sorted recursively; undefined object members dropped (JSON semantics). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Digest of a canonicalized structured value (tool inputs, policy, contracts). */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Effect idempotency/operation key (plan 5.3): run revision + site/step ordinal
 * + tool-call ordinal + canonical input digest. Passing a key to a shell does
 * not make the command idempotent; the key only identifies the receipt row.
 */
export function operationKey(parts: {
  runRevision: string;
  siteId: string;
  ordinal: number;
  toolOrdinal: number;
  inputDigest: string;
}): string {
  return sha256Hex(
    [parts.runRevision, parts.siteId, String(parts.ordinal), String(parts.toolOrdinal), parts.inputDigest].join("\n"),
  );
}
