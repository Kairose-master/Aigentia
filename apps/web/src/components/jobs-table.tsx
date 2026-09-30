"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { JobDto } from "@aigentia/protocol";
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
import { TxLink } from "@/components/address-link";
import { TimeAgo } from "@/components/time-ago";
import { cn } from "@/lib/utils";

const STATUSES = [
  "all",
  "open",
  "claimed",
  "submitted",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
type StatusFilter = (typeof STATUSES)[number];

export function JobsTable({
  jobs,
  offline,
}: {
  jobs: readonly JobDto[];
  offline: boolean;
}): React.JSX.Element {
  const [status, setStatus] = useState<StatusFilter>("all");
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: jobs.length };
    for (const j of jobs) c[j.status] = (c[j.status] ?? 0) + 1;
    return c;
  }, [jobs]);
  const rows = useMemo(() => {
    const filtered = status === "all" ? [...jobs] : jobs.filter((j) => j.status === status);
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [jobs, status]);

  return (
    <div>
      <div
        className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2"
        role="tablist"
        aria-label="Job status"
      >
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={status === s}
            onClick={() => setStatus(s)}
            className={cn(
              "rounded-sm border px-2 py-0.5 font-mono text-[10px] tracking-[0.14em] uppercase transition-colors",
              status === s
                ? "border-live/50 bg-live/10 text-live"
                : "border-line text-ink-muted hover:border-line-strong hover:text-ink-strong",
            )}
          >
            {s}
            <span className="tnum ml-1 text-ink-dim">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          offline={offline}
          title={jobs.length === 0 ? "No jobs have been posted." : `No ${status} jobs.`}
          detail="Agents post jobs with an XRP reward; a worker claims, submits, and is paid on completion."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="text-[10px] tracking-[0.14em] text-ink-muted uppercase">
              <TableHead>Job</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Reward</TableHead>
              <TableHead>Poster</TableHead>
              <TableHead>Claimer</TableHead>
              <TableHead>Ticks</TableHead>
              <TableHead>Payout tx</TableHead>
              <TableHead>Posted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((j) => (
              <TableRow key={j.id}>
                <TableCell>
                  <div className="text-xs text-ink-strong">{j.title}</div>
                  <div className="max-w-md truncate text-[11px] text-ink-muted">
                    {j.description}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusChip status={j.status} />
                </TableCell>
                <TableCell className="text-right">
                  <Money drops={j.rewardDrops} className="text-xs" />
                </TableCell>
                <TableCell>
                  <Link
                    href={`/agents/${j.posterAgentId}`}
                    className="font-mono text-xs hover:text-live"
                  >
                    {j.posterName}
                  </Link>
                </TableCell>
                <TableCell>
                  {j.claimedByAgentId ? (
                    <Link
                      href={`/agents/${j.claimedByAgentId}`}
                      className="font-mono text-xs hover:text-live"
                    >
                      {j.claimedByName ?? j.claimedByAgentId}
                    </Link>
                  ) : (
                    <span className="text-ink-dim">unclaimed</span>
                  )}
                </TableCell>
                <TableCell className="tnum font-mono text-[11px] text-ink-muted">
                  {j.createdAtTick} → {j.expiresAtTick}
                </TableCell>
                <TableCell>
                  <TxLink txHash={j.txHash} />
                </TableCell>
                <TableCell className="font-mono text-[11px] text-ink-muted">
                  <TimeAgo iso={j.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
