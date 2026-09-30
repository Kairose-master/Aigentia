import { sha256Hex } from "./hash";

/**
 * Deterministic pseudo-random generator (xoshiro128**) seeded from a string.
 * Used by the world simulation and DeterministicAgent so runs are reproducible.
 */
export class SeededRandom {
  private s: [number, number, number, number];

  constructor(seed: string) {
    const h = sha256Hex(seed);
    this.s = [
      parseInt(h.slice(0, 8), 16) >>> 0,
      parseInt(h.slice(8, 16), 16) >>> 0,
      parseInt(h.slice(16, 24), 16) >>> 0,
      parseInt(h.slice(24, 32), 16) >>> 0,
    ];
    if (this.s.every((x) => x === 0)) this.s[0] = 1;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    const [a, b, c, d] = this.s;
    const result = (Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0) / 4294967296;
    const t = (b << 9) >>> 0;
    let nc = (c ^ a) >>> 0;
    let nd = (d ^ b) >>> 0;
    const nb = (b ^ nc) >>> 0;
    const na = (a ^ nd) >>> 0;
    nc = (nc ^ t) >>> 0;
    nd = rotl(nd, 11) >>> 0;
    this.s = [na, nb, nc, nd];
    return result;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("cannot pick from empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /** Derive an independent generator for a sub-scope (agent, tick…). */
  fork(scope: string): SeededRandom {
    return new SeededRandom(`${this.next()}:${scope}`);
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function deriveSeed(...parts: (string | number)[]): string {
  return sha256Hex(parts.join("|"));
}
