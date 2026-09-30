"use client";

import Link from "next/link";
import type { AgentProfileDto } from "@aigentia/protocol";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DecisionTraceCard } from "@/components/decision-trace-card";
import { EmptyState } from "@/components/panel";
import { Money } from "@/components/money";
import { StatusChip } from "@/components/status-chip";
import { TxLink } from "@/components/address-link";
import { LedgerBadge } from "@/components/ledger-badge";
import { formatLatency, formatNumber } from "@/lib/format";
import { TimeAgo } from "@/components/time-ago";
import { cn } from "@/lib/utils";

const HEAD = "text-[10px] tracking-[0.14em] text-ink-muted uppercase";

function Trigger({ value, count }: { value: string; count: number }): React.JSX.Element {
  return (
    <TabsTrigger value={value} className="font-mono text-[11px] tracking-[0.12em] uppercase">
      {value}
      <span className="tnum ml-1 text-[10px] text-ink-dim">{count}</span>
    </TabsTrigger>
  );
}

export function AgentTabs({ profile }: { profile: AgentProfileDto }): React.JSX.Element {
  const me = profile.agent.id;
  const decisions = [...profile.decisions].sort(
    (a, b) => b.tick - a.tick || b.createdAt.localeCompare(a.createdAt),
  );
  const payments = [...profile.payments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const reputation = [...profile.reputationHistory].sort((a, b) => b.tick - a.tick);

  return (
    <Tabs defaultValue="decisions" className="gap-3">
      <TabsList variant="line" className="flex-wrap border-b border-line pb-1">
        <Trigger value="decisions" count={decisions.length} />
        <Trigger value="transactions" count={payments.length} />
        <Trigger value="services" count={profile.services.length} />
        <Trigger value="jobs" count={profile.jobs.length} />
        <Trigger value="inventory" count={profile.inventory.length} />
        <Trigger value="reputation" count={reputation.length} />
      </TabsList>

      <TabsContent value="decisions">
        {decisions.length === 0 ? (
          <EmptyState title="No decisions recorded for this agent yet." />
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {decisions.map((d) => (
              <DecisionTraceCard key={d.id} trace={d} />
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="transactions">
        {payments.length === 0 ? (
          <EmptyState title="No payments involving this agent." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={HEAD}>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Counterparty</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Ledger</TableHead>
                <TableHead>Tx</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => {
                const outgoing = p.senderAgentId === me;
                const cpId = outgoing ? p.receiverAgentId : p.senderAgentId;
                const cpName = outgoing ? p.receiverName : p.senderName;
                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-[11px] text-ink-muted uppercase">
                      {p.kind}
                    </TableCell>
                    <TableCell>
                      <StatusChip status={p.status} />
                    </TableCell>
                    <TableCell
                      className={cn(
                        "font-mono text-[11px] uppercase",
                        outgoing ? "text-warn" : "text-ok",
                      )}
                    >
                      {outgoing ? "out" : "in"}
                    </TableCell>
                    <TableCell>
                      {cpId ? (
                        <Link
                          href={`/agents/${cpId}`}
                          className="font-mono text-xs hover:text-live"
                        >
                          {cpName ?? cpId}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">{cpName ?? "external"}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money
                        drops={p.amountDrops}
                        tone={outgoing ? "warn" : "ok"}
                        className="text-xs"
                      />
                    </TableCell>
                    <TableCell>
                      <LedgerBadge ledger={p.ledger} className="h-5 text-[9px]" />
                    </TableCell>
                    <TableCell>
                      <TxLink txHash={p.txHash} ledger={p.ledger} explorerUrl={p.explorerUrl} />
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-ink-muted">
                      <TimeAgo iso={p.validatedAt ?? p.createdAt} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TabsContent>

      <TabsContent value="services">
        {profile.services.length === 0 ? (
          <EmptyState title="This agent sells no services." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={HEAD}>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">OK</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profile.services.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <span className="font-mono text-xs text-ink-strong">{s.kind}</span>
                    <span className="ml-2 text-[11px] text-ink-muted">{s.category}</span>
                  </TableCell>
                  <TableCell>
                    <StatusChip status={s.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money drops={s.priceDrops} className="text-xs" />
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-ok">
                    {formatNumber(s.successfulCalls)}
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-bad">
                    {formatNumber(s.failedCalls)}
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-ink-muted">
                    {formatLatency(s.avgLatencyMs)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money drops={s.totalRevenueDrops} tone="ok" className="text-xs" />
                  </TableCell>
                  <TableCell className="tnum text-right font-mono">{s.score.toFixed(3)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabsContent>

      <TabsContent value="jobs">
        {profile.jobs.length === 0 ? (
          <EmptyState title="No jobs posted or claimed by this agent." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={HEAD}>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Reward</TableHead>
                <TableHead>Ticks</TableHead>
                <TableHead>Tx</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profile.jobs.map((j) => (
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
                  <TableCell className="font-mono text-[11px] text-ink-muted uppercase">
                    {j.posterAgentId === me ? "poster" : j.claimedByAgentId === me ? "worker" : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money drops={j.rewardDrops} className="text-xs" />
                  </TableCell>
                  <TableCell className="tnum font-mono text-[11px] text-ink-muted">
                    {j.createdAtTick} → {j.expiresAtTick}
                  </TableCell>
                  <TableCell>
                    <TxLink txHash={j.txHash} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabsContent>

      <TabsContent value="inventory">
        {profile.inventory.length === 0 ? (
          <EmptyState title="Empty inventory." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={HEAD}>
                <TableHead>Resource</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Location</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profile.inventory.map((i, idx) => (
                <TableRow key={`${i.resourceType}-${i.locationId}-${idx}`}>
                  <TableCell className="font-mono text-xs">{i.resourceType}</TableCell>
                  <TableCell className="tnum text-right font-mono">
                    {formatNumber(i.quantity)}
                  </TableCell>
                  <TableCell className="text-ink-muted">{i.locationId}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabsContent>

      <TabsContent value="reputation">
        {reputation.length === 0 ? (
          <EmptyState title="No reputation events yet." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className={HEAD}>
                <TableHead>Tick</TableHead>
                <TableHead className="text-right">Delta</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reputation.map((r, idx) => (
                <TableRow key={`${r.tick}-${idx}`}>
                  <TableCell className="tnum font-mono text-[11px] text-ink-muted">
                    {r.tick}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "tnum text-right font-mono text-xs",
                      r.delta >= 0 ? "text-ok" : "text-bad",
                    )}
                  >
                    {r.delta >= 0 ? "+" : ""}
                    {r.delta.toFixed(2)}
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">{r.reason}</TableCell>
                  <TableCell className="font-mono text-[11px] text-ink-muted">
                    <TimeAgo iso={r.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabsContent>
    </Tabs>
  );
}
