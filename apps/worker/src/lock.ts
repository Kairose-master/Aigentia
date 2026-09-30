import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

/** A held lock; `release` returns false when the lock had already expired or changed hands. */
export interface LockHandle {
  readonly key: string;
  readonly token: string;
  release(): Promise<boolean>;
}

/** Mutual exclusion for the tick loop: at most one tick runs at a time across all workers. */
export interface TickLock {
  /** Returns null when the lock is held by someone else. */
  acquire(key: string, ttlMs: number): Promise<LockHandle | null>;
}

export const TICK_LOCK_KEY = "aigentia:lock:tick";

/** Compare-and-delete: only the holder (matching token) may release. */
export const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export function newLockToken(): string {
  return randomBytes(16).toString("hex");
}

/** SET key token NX PX ttl, released with a compare-and-delete Lua script. */
export class RedisLock implements TickLock {
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, ttlMs: number): Promise<LockHandle | null> {
    const token = newLockToken();
    const ok = await this.redis.set(key, token, "PX", Math.max(1, Math.floor(ttlMs)), "NX");
    if (ok !== "OK") return null;
    return {
      key,
      token,
      release: async () => {
        const deleted = await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
        return deleted === 1;
      },
    };
  }
}

/** Process-local lock with the same semantics (tests, in-process demo). */
export class InMemoryLock implements TickLock {
  private readonly held = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  async acquire(key: string, ttlMs: number): Promise<LockHandle | null> {
    const now = this.clock();
    const current = this.held.get(key);
    if (current && current.expiresAt > now) return null;
    const token = newLockToken();
    this.held.set(key, { token, expiresAt: now + ttlMs });
    return {
      key,
      token,
      release: async () => {
        const entry = this.held.get(key);
        if (!entry || entry.token !== token) return false;
        this.held.delete(key);
        return true;
      },
    };
  }

  isHeld(key: string): boolean {
    const entry = this.held.get(key);
    return entry !== undefined && entry.expiresAt > this.clock();
  }
}
