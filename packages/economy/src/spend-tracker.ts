export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Records validated outgoing payments so the PolicyEngine can enforce rolling hourly and
 * daily caps. Implementations: {@link InMemorySpendTracker} (tests, mock simulations) and a
 * database-backed tracker in the game engine.
 */
export interface SpendTracker {
  record(agentId: string, amountDrops: bigint, at: Date): Promise<void>;
  /** Sum of amounts recorded at or after `since`. */
  spentSince(agentId: string, since: Date): Promise<bigint>;
}

export interface SpendWindows {
  readonly hourAgo: Date;
  readonly dayAgo: Date;
}

/** Window starts for the rolling caps at `now`. */
export function windows(now: Date): SpendWindows {
  return { hourAgo: new Date(now.getTime() - HOUR_MS), dayAgo: new Date(now.getTime() - DAY_MS) };
}

export interface SpentWindows {
  readonly spentLastHourDrops: bigint;
  readonly spentLastDayDrops: bigint;
}

/** Both rolling totals the PolicyEngine context needs, in one call. */
export async function spentInWindows(
  tracker: SpendTracker,
  agentId: string,
  now: Date,
): Promise<SpentWindows> {
  const { hourAgo, dayAgo } = windows(now);
  const [spentLastHourDrops, spentLastDayDrops] = await Promise.all([
    tracker.spentSince(agentId, hourAgo),
    tracker.spentSince(agentId, dayAgo),
  ]);
  return { spentLastHourDrops, spentLastDayDrops };
}

interface SpendEntry {
  readonly atMs: number;
  readonly amountDrops: bigint;
}

export class InMemorySpendTracker implements SpendTracker {
  private readonly entries = new Map<string, SpendEntry[]>();

  async record(agentId: string, amountDrops: bigint, at: Date): Promise<void> {
    if (amountDrops < 0n) throw new RangeError("spend amount must be non-negative");
    const list = this.entries.get(agentId) ?? [];
    list.push({ atMs: at.getTime(), amountDrops });
    this.entries.set(agentId, list);
  }

  async spentSince(agentId: string, since: Date): Promise<bigint> {
    const sinceMs = since.getTime();
    let total = 0n;
    for (const entry of this.entries.get(agentId) ?? []) {
      if (entry.atMs >= sinceMs) total += entry.amountDrops;
    }
    return total;
  }

  /** Drop entries older than `before` (e.g. older than a day) to bound memory. */
  prune(before: Date): void {
    const beforeMs = before.getTime();
    for (const [agentId, list] of this.entries) {
      const kept = list.filter((e) => e.atMs >= beforeMs);
      if (kept.length === 0) this.entries.delete(agentId);
      else this.entries.set(agentId, kept);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
