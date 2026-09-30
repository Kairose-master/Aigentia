import Link from "next/link";
import type { AgentSummaryDto } from "@aigentia/protocol";
import { Money } from "@/components/money";
import { ObjectiveBadge } from "@/components/objective-badge";
import { StatusChip } from "@/components/status-chip";
import { EmptyState } from "@/components/panel";
import { compareDropsDesc } from "@/lib/format";

export function TopAgents({
  agents,
  offline,
  limit = 8,
}: {
  agents: readonly AgentSummaryDto[];
  offline: boolean;
  limit?: number;
}): React.JSX.Element {
  const ranked = [...agents]
    .sort((a, b) => compareDropsDesc(a.netWorthDrops, b.netWorthDrops))
    .slice(0, limit);
  if (ranked.length === 0) {
    return <EmptyState offline={offline} title="No agents in the world yet." />;
  }
  return (
    <ol data-testid="top-agents">
      {ranked.map((a, i) => (
        <li
          key={a.id}
          className="grid grid-cols-[24px_1fr_auto] items-center gap-2 border-b border-line/70 px-3 py-1.5 last:border-0"
        >
          <span className="tnum font-mono text-[11px] text-ink-dim">
            {String(i + 1).padStart(2, "0")}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link
                href={`/agents/${a.id}`}
                className="truncate font-mono text-xs font-medium text-ink-strong hover:text-live"
              >
                {a.name}
              </Link>
              <StatusChip status={a.status} />
            </div>
            <ObjectiveBadge objective={a.objective} className="text-[11px] text-ink-muted" />
          </div>
          <Money drops={a.netWorthDrops} maxFraction={2} className="text-xs" />
        </li>
      ))}
    </ol>
  );
}
