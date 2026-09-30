"use client";

import type { StatsDto } from "@aigentia/protocol";
import { useLive } from "@/components/live-provider";
import { StatTile } from "@/components/stat-tile";
import { formatNumber, formatXrpCompact } from "@/lib/format";
import { TimeAgo } from "@/components/time-ago";

/** Hero stats strip; server-seeded, then updated from the SSE `stats` channel. */
export function StatsStrip({ initial }: { initial: StatsDto | null }): React.JSX.Element {
  const live = useLive();
  const stats = live.stats;
  const hint: React.ReactNode = live.connected ? (
    `streaming · tick ${stats ? formatNumber(stats.tick) : "—"}`
  ) : initial ? (
    <>
      snapshot <TimeAgo iso={initial.updatedAt} />
    </>
  ) : (
    "API offline"
  );
  return (
    <div
      data-testid="stats-strip"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line md:grid-cols-5"
    >
      <StatTile
        label="Agents"
        value={stats ? formatNumber(stats.agents) : "—"}
        hint={initial ? `${formatNumber(initial.activeAgents)} active` : "—"}
        tone="live"
        testId="stat-agents"
      />
      <StatTile
        label="Transactions"
        value={stats ? formatNumber(stats.transactions) : "—"}
        hint="validated on ledger"
        tone="ok"
        testId="stat-transactions"
      />
      <StatTile
        label="Service purchases"
        value={stats ? formatNumber(stats.servicePurchases) : "—"}
        hint="x402 agent-to-agent"
        tone="violet"
        testId="stat-purchases"
      />
      <StatTile
        label="Active jobs"
        value={stats ? formatNumber(stats.activeJobs) : "—"}
        hint="open or claimed"
        tone="warn"
        testId="stat-jobs"
      />
      <StatTile
        label="Economic volume"
        value={stats ? formatXrpCompact(stats.volumeDrops) : "—"}
        unit="XRP"
        hint={hint}
        tone="live"
        testId="stat-volume"
      />
    </div>
  );
}
