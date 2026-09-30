import Link from "next/link";
import type { ExperimentResults } from "@aigentia/protocol";
import { getExperiment } from "@/lib/api";
import { Panel, PageHeader, OfflineBanner, EmptyState } from "@/components/panel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatTile } from "@/components/stat-tile";
import { StatusChip } from "@/components/status-chip";
import { Money } from "@/components/money";
import { Countdown } from "@/components/countdown";
import { NetworkGraph } from "@/components/network-graph";
import { ObjectiveBadge } from "@/components/objective-badge";
import {
  formatDateTime,
  formatNumber,
  formatPercent,
  formatXrp,
  formatXrpCompact,
} from "@/lib/format";

export const dynamic = "force-dynamic";

const HEAD = "text-[10px] tracking-[0.14em] text-ink-muted uppercase";

function Leaderboard({
  rows,
  label,
}: {
  rows: ExperimentResults["wealthLeaderboard"];
  label: string;
}): React.JSX.Element {
  if (rows.length === 0) return <EmptyState title={`No ${label} data.`} />;
  const top = rows[0] ? Math.max(1, Number(BigInt(rows[0].valueDrops) / 1000n)) : 1;
  return (
    <ol>
      {rows.slice(0, 12).map((r) => {
        const share = Math.min(100, (Number(BigInt(r.valueDrops) / 1000n) / top) * 100);
        return (
          <li
            key={r.agentId}
            className="grid grid-cols-[28px_1fr_auto] items-center gap-2 border-b border-line/70 px-3 py-1.5 last:border-0"
          >
            <span className="tnum font-mono text-[11px] text-ink-dim">
              {String(r.rank).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <Link
                href={`/agents/${r.agentId}`}
                className="font-mono text-xs text-ink-strong hover:text-live"
              >
                {r.name}
              </Link>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-sm bg-line">
                <div className="h-full bg-live/70" style={{ width: `${share}%` }} />
              </div>
            </div>
            <Money drops={r.valueDrops} maxFraction={2} className="text-xs" />
          </li>
        );
      })}
    </ol>
  );
}

export default async function ExperimentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const result = await getExperiment(id);
  if (result.error) {
    const offline = result.error.offline;
    return (
      <div>
        <PageHeader title="Experiment" subtitle={id} />
        {offline && <OfflineBanner />}
        <Panel>
          <EmptyState
            offline={offline}
            title={
              result.error.code === "NOT_FOUND"
                ? `No experiment with id ${id}.`
                : "Experiment unavailable."
            }
            detail={result.error.message}
          />
          <div className="border-t border-line px-4 py-3">
            <Link
              href="/experiments"
              className="font-mono text-[11px] tracking-[0.14em] text-live uppercase"
            >
              ← all experiments
            </Link>
          </div>
        </Panel>
      </div>
    );
  }

  const exp = result.data;
  const cfg = exp.config;
  const res = exp.results;
  const totalPayments = res ? res.failedPayments + res.verifiedPayments : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={exp.name}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-3">
            <StatusChip status={exp.status} />
            <span className="font-mono text-[11px] text-ink-muted">{exp.id}</span>
            <span className="font-mono text-[11px] text-ink-muted">
              created {formatDateTime(exp.createdAt)}
            </span>
          </span>
        }
        action={
          <Link
            href="/experiments"
            className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase hover:text-live"
          >
            ← experiments
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line md:grid-cols-5">
        <StatTile
          label="Status"
          value={<StatusChip status={exp.status} className="h-6 text-xs" />}
          tone="live"
        />
        <StatTile
          label={exp.status === "running" ? "Time remaining" : "Ends"}
          value={
            exp.status === "running" ? (
              <Countdown endsAt={exp.endsAt} />
            ) : exp.endsAt ? (
              formatDateTime(exp.endsAt).slice(0, 16)
            ) : (
              "—"
            )
          }
          tone="warn"
        />
        <StatTile
          label="Agents"
          value={formatNumber(exp.agentCount)}
          hint={`${cfg.agentCount} configured`}
          tone="live"
        />
        <StatTile
          label="Duration"
          value={`${cfg.durationHours}h`}
          hint={cfg.tickSeconds ? `${cfg.tickSeconds}s / tick` : undefined}
        />
        <StatTile
          label="Starting capital"
          value={formatNumber(cfg.startingCapitalXrp, 2)}
          unit="XRP"
          hint="per agent"
          tone="ok"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Panel eyebrow="Configuration" title="Experiment config" bodyClassName="px-3 py-2 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-ink-muted">seed</dt>
            <dd className="truncate font-mono">{cfg.seed}</dd>
            <dt className="text-ink-muted">brain</dt>
            <dd className="font-mono">{cfg.brain}</dd>
            <dt className="text-ink-muted">human intervention</dt>
            <dd className="font-mono text-ok">none after start</dd>
            <dt className="text-ink-muted">started</dt>
            <dd className="font-mono">{formatDateTime(exp.startedAt)}</dd>
            <dt className="text-ink-muted">ends</dt>
            <dd className="font-mono">{formatDateTime(exp.endsAt)}</dd>
            <dt className="text-ink-muted">finished</dt>
            <dd className="font-mono">{formatDateTime(exp.finishedAt)}</dd>
            {cfg.budgetPolicy && (
              <>
                <dt className="text-ink-muted">max / action</dt>
                <dd className="tnum font-mono">
                  {formatXrp(cfg.budgetPolicy.maxSpendPerActionDrops)} XRP
                </dd>
                <dt className="text-ink-muted">max / day</dt>
                <dd className="tnum font-mono">
                  {formatXrp(cfg.budgetPolicy.maxDailySpendDrops)} XRP
                </dd>
                <dt className="text-ink-muted">min balance</dt>
                <dd className="tnum font-mono">
                  {formatXrp(cfg.budgetPolicy.minimumBalanceDrops)} XRP
                </dd>
              </>
            )}
          </dl>
          <div className="mt-3 border-t border-line pt-2">
            <div className="eyebrow mb-1">Objective distribution</div>
            <ul className="grid gap-1">
              {cfg.objectiveDistribution.map((o) => (
                <li key={o.objective} className="flex items-center justify-between gap-2">
                  <ObjectiveBadge objective={o.objective} />
                  <span className="tnum font-mono">{o.count}</span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>

        {res ? (
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-3">
            <StatTile
              label="Ticks"
              value={formatNumber(res.ticks)}
              hint={`computed ${formatDateTime(res.computedAt)}`}
            />
            <StatTile
              label="Verified volume"
              value={formatXrpCompact(res.totalVolumeDrops)}
              unit="XRP"
              tone="ok"
              hint="validated on ledger"
            />
            <StatTile label="Trades" value={formatNumber(res.tradeCount)} tone="violet" />
            <StatTile
              label="Survival"
              value={`${res.survival.alive} / ${res.survival.alive + res.survival.bankrupt}`}
              hint={`${res.survival.bankrupt} bankrupt`}
              tone={res.survival.bankrupt > 0 ? "warn" : "ok"}
            />
            <StatTile
              label="Gini"
              value={res.economicConcentration.gini.toFixed(3)}
              hint="0 equal · 1 concentrated"
              tone="warn"
            />
            <StatTile
              label="Top 10% share"
              value={formatPercent(res.economicConcentration.top10PercentShare)}
              hint="of total wealth"
              tone="warn"
            />
          </div>
        ) : (
          <Panel eyebrow="Results" title="Not yet computed">
            <EmptyState
              title={
                exp.status === "running"
                  ? "Results are computed when the experiment finishes."
                  : "No results recorded for this experiment."
              }
            />
          </Panel>
        )}
      </div>

      {res && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel eyebrow="Leaderboard" title="Wealth" bodyClassName="max-h-96 overflow-y-auto">
              <Leaderboard rows={res.wealthLeaderboard} label="wealth" />
            </Panel>
            <Panel eyebrow="Leaderboard" title="Revenue" bodyClassName="max-h-96 overflow-y-auto">
              <Leaderboard rows={res.revenueLeaderboard} label="revenue" />
            </Panel>
            <Panel eyebrow="Settlement" title="Payments" bodyClassName="px-3 py-3">
              <div className="mb-2 flex h-3 w-full overflow-hidden rounded-sm bg-line">
                <div
                  className="h-full bg-ok"
                  style={{
                    width: `${totalPayments ? (res.verifiedPayments / totalPayments) * 100 : 0}%`,
                  }}
                  title="verified"
                />
                <div
                  className="h-full bg-bad"
                  style={{
                    width: `${totalPayments ? (res.failedPayments / totalPayments) * 100 : 0}%`,
                  }}
                  title="failed"
                />
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="inline-flex items-center gap-1.5 text-ink-muted">
                  <span className="size-2 rounded-sm bg-ok" />
                  verified
                </dt>
                <dd className="tnum font-mono text-ok">{formatNumber(res.verifiedPayments)}</dd>
                <dt className="inline-flex items-center gap-1.5 text-ink-muted">
                  <span className="size-2 rounded-sm bg-bad" />
                  failed
                </dt>
                <dd className="tnum font-mono text-bad">{formatNumber(res.failedPayments)}</dd>
                <dt className="text-ink-muted">success rate</dt>
                <dd className="tnum font-mono">
                  {totalPayments ? formatPercent(res.verifiedPayments / totalPayments) : "—"}
                </dd>
              </dl>
              <div className="mt-3 border-t border-line pt-2">
                <div className="eyebrow mb-1">Survivors</div>
                <p className="text-[11px] text-ink-muted">
                  {res.survival.survivors.length === 0
                    ? "none"
                    : res.survival.survivors.slice(0, 20).join(", ")}
                  {res.survival.survivors.length > 20
                    ? ` +${res.survival.survivors.length - 20} more`
                    : ""}
                </p>
              </div>
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel eyebrow="Demand" title="Most-used services">
              {res.mostUsedServices.length === 0 ? (
                <EmptyState title="No service calls." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className={HEAD}>
                      <TableHead>Kind</TableHead>
                      <TableHead>Seller</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {res.mostUsedServices.map((s) => (
                      <TableRow key={s.serviceId}>
                        <TableCell className="font-mono text-xs">{s.kind}</TableCell>
                        <TableCell className="font-mono text-xs text-ink-muted">
                          {s.sellerName}
                        </TableCell>
                        <TableCell className="tnum text-right font-mono text-xs">
                          {formatNumber(s.calls)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Panel>
            <Panel eyebrow="Supply" title="Service usage">
              {res.serviceUsage.length === 0 ? (
                <EmptyState title="No service usage." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className={HEAD}>
                      <TableHead>Kind</TableHead>
                      <TableHead>Seller</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead className="text-right">Failures</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...res.serviceUsage]
                      .sort((a, b) => b.calls - a.calls)
                      .map((s) => (
                        <TableRow key={s.serviceId}>
                          <TableCell className="font-mono text-xs">{s.kind}</TableCell>
                          <TableCell>
                            <Link
                              href={`/agents/${s.sellerAgentId}`}
                              className="font-mono text-xs text-ink-muted hover:text-live"
                            >
                              {res.networkGraph.nodes.find((n) => n.id === s.sellerAgentId)?.name ??
                                s.sellerAgentId}
                            </Link>
                          </TableCell>
                          <TableCell className="tnum text-right font-mono text-xs">
                            {formatNumber(s.calls)}
                          </TableCell>
                          <TableCell className="tnum text-right font-mono text-xs text-bad">
                            {formatNumber(s.failures)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Money drops={s.revenueDrops} tone="ok" className="text-xs" />
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
            </Panel>
          </div>

          <Panel eyebrow="Topology" title="Agent-to-agent transaction network">
            <NetworkGraph graph={res.networkGraph} />
          </Panel>
        </>
      )}
    </div>
  );
}
