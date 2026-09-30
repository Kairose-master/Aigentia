import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** JSON with sorted keys so equal objects hash equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export function utf8ToHex(text: string): string {
  return Buffer.from(text, "utf8").toString("hex").toUpperCase();
}

export function hexToUtf8(hex: string): string {
  return Buffer.from(hex, "hex").toString("utf8");
}
