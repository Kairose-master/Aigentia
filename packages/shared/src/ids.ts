import { customAlphabet } from "nanoid";
import { ID_PREFIXES, type IdPrefix } from "./constants";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const random = customAlphabet(alphabet, 16);

/** Random, URL-safe, prefixed identifier such as `agt_3k9x...`. */
export function newId(kind: IdPrefix): string {
  return `${ID_PREFIXES[kind]}_${random()}`;
}

/** Deterministic identifier derived from a seed, for reproducible simulations. */
export function deterministicId(kind: IdPrefix, seed: string): string {
  // FNV-1a 64-bit folded to 16 base36 chars — stable across runs and platforms.
  let h1 = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < seed.length; i++) {
    h1 ^= BigInt(seed.charCodeAt(i));
    h1 = (h1 * prime) & mask;
  }
  let h2 = h1 ^ 0x9e3779b97f4a7c15n;
  for (let i = seed.length - 1; i >= 0; i--) {
    h2 ^= BigInt(seed.charCodeAt(i));
    h2 = (h2 * prime) & mask;
  }
  const s = (h1.toString(36) + h2.toString(36)).padEnd(16, "0").slice(0, 16);
  return `${ID_PREFIXES[kind]}_${s}`;
}

export function idKind(id: string): IdPrefix | undefined {
  const prefix = id.split("_")[0];
  return (Object.keys(ID_PREFIXES) as IdPrefix[]).find((k) => ID_PREFIXES[k] === prefix);
}
