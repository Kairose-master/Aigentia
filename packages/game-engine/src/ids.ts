import { deterministicId, newId, type IdPrefix } from "@aigentia/shared";

/**
 * Where every engine identifier comes from. The store never invents ids: the engine hands
 * them in so a seeded world (mock ledger, deterministic brains) reproduces exactly and a
 * production world (random ids) never collides across restarts.
 */
export interface IdGenerator {
  /** `scope` groups a sequence (e.g. `${tick}:${agentId}`); only the deterministic generator uses it. */
  next(kind: IdPrefix, scope?: string): string;
}

/**
 * Reproducible ids: `deterministicId(kind, `${seed}|${kind}|${scope}|${n}`)` where `n` counts
 * calls per (kind, scope). Scopes that embed the tick and agent id are restart-safe as long
 * as a tick is never re-run.
 */
export class DeterministicIdGenerator implements IdGenerator {
  private readonly counters = new Map<string, number>();

  constructor(private readonly seed: string) {}

  next(kind: IdPrefix, scope = ""): string {
    const key = `${kind}|${scope}`;
    const n = this.counters.get(key) ?? 0;
    this.counters.set(key, n + 1);
    return deterministicId(kind, `${this.seed}|${kind}|${scope}|${n}`);
  }

  /** Forget every counter (a fresh world on the same seed starts from zero again). */
  reset(): void {
    this.counters.clear();
  }
}

/** Random, URL-safe ids for production worlds. */
export class RandomIdGenerator implements IdGenerator {
  next(kind: IdPrefix): string {
    return newId(kind);
  }
}
