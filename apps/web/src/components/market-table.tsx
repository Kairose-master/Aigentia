"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ServiceListingDto } from "@aigentia/protocol";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/panel";
import { Money } from "@/components/money";
import { StatusChip } from "@/components/status-chip";
import { ReputationBar } from "@/components/reputation-bar";
import { formatLatency, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const KINDS = ["ALL", "SCOUT", "ANALYST", "COURIER"] as const;
type KindFilter = (typeof KINDS)[number];

export function KindFilterBar({
  value,
  onChange,
  counts,
}: {
  value: KindFilter;
  onChange: (k: KindFilter) => void;
  counts: Record<string, number>;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Service kind">
      {KINDS.map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={value === k}
          onClick={() => onChange(k)}
          className={cn(
            "rounded-sm border px-2 py-0.5 font-mono text-[10px] tracking-[0.14em] uppercase transition-colors",
            value === k
              ? "border-live/50 bg-live/10 text-live"
              : "border-line text-ink-muted hover:border-line-strong hover:text-ink-strong",
          )}
        >
          {k}
          <span className="tnum ml-1 text-ink-dim">{counts[k] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

export function MarketTable({
  services,
  offline,
}: {
  services: readonly ServiceListingDto[];
  offline: boolean;
}): React.JSX.Element {
  const [kind, setKind] = useState<KindFilter>("ALL");
  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: services.length };
    for (const s of services) c[s.kind] = (c[s.kind] ?? 0) + 1;
    return c;
  }, [services]);
  const rows = useMemo(() => {
    const filtered = kind === "ALL" ? [...services] : services.filter((s) => s.kind === kind);
    return filtered.sort((a, b) => b.score - a.score);
  }, [services, kind]);

  return (
    <div>
      <div className="flex items-center gap-3 border-b border-line px-3 py-2">
        <KindFilterBar value={kind} onChange={setKind} counts={counts} />
        <span className="ml-auto font-mono text-[10px] tracking-[0.14em] text-ink-muted uppercase">
          ranked by score
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          offline={offline}
          title={
            services.length === 0
              ? "No services listed on the marketplace."
              : `No ${kind} services.`
          }
          detail="Agents list SCOUT, ANALYST and COURIER services and sell them over x402."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="text-[10px] tracking-[0.14em] text-ink-muted uppercase">
              <TableHead>#</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Seller</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">OK</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Avg latency</TableHead>
              <TableHead>Reputation</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Score</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s, i) => (
              <TableRow key={s.id}>
                <TableCell className="tnum font-mono text-[11px] text-ink-dim">
                  {String(i + 1).padStart(2, "0")}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs font-medium text-ink-strong">{s.kind}</span>
                  <span className="ml-2 text-[11px] text-ink-muted">{s.category}</span>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/agents/${s.sellerAgentId}`}
                    className="font-mono text-xs hover:text-live"
                  >
                    {s.sellerName}
                  </Link>
                </TableCell>
                <TableCell className="text-right">
                  <Money drops={s.priceDrops} className="text-xs" />
                </TableCell>
                <TableCell className="tnum text-right font-mono text-xs text-ok">
                  {formatNumber(s.successfulCalls)}
                </TableCell>
                <TableCell className="tnum text-right font-mono text-xs text-bad">
                  {formatNumber(s.failedCalls)}
                </TableCell>
                <TableCell className="tnum text-right font-mono text-xs text-ink-muted">
                  {formatLatency(s.avgLatencyMs)}
                </TableCell>
                <TableCell>
                  <ReputationBar value={s.sellerReputation} />
                </TableCell>
                <TableCell className="text-right">
                  <Money drops={s.totalRevenueDrops} tone="ok" className="text-xs" />
                </TableCell>
                <TableCell className="tnum text-right font-mono text-xs text-ink-strong">
                  {s.score.toFixed(3)}
                </TableCell>
                <TableCell>
                  <StatusChip status={s.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
