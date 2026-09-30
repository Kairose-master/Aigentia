import Link from "next/link";
import { getExperiments } from "@/lib/api";
import { Panel, PageHeader, OfflineBanner, EmptyState } from "@/components/panel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusChip } from "@/components/status-chip";
import { formatDateTime, formatNumber, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ExperimentsPage(): Promise<React.JSX.Element> {
  const result = await getExperiments();
  const offline = result.error?.offline === true;
  const experiments = [...(result.data ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Experiments"
        subtitle="Timed runs with a fixed population, seed and objective mix. Once started, no human intervenes; results are computed from recorded state and verified payments."
      />
      {offline && <OfflineBanner />}
      <Panel eyebrow="Laboratory" title="Runs">
        {experiments.length === 0 ? (
          <EmptyState
            offline={offline}
            title="No experiments yet."
            detail="POST /api/admin/experiments with an ExperimentConfig to schedule one."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="text-[10px] tracking-[0.14em] text-ink-muted uppercase">
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Agents</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Brain</TableHead>
                <TableHead>Seed</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Ends</TableHead>
                <TableHead>Results</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {experiments.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Link
                      href={`/experiments/${e.id}`}
                      className="font-mono text-xs font-medium text-ink-strong hover:text-live"
                    >
                      {e.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusChip status={e.status} />
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-xs">
                    {formatNumber(e.agentCount)}
                  </TableCell>
                  <TableCell className="tnum text-right font-mono text-xs">
                    {e.config.durationHours}h
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-ink-muted">
                    {e.config.brain}
                  </TableCell>
                  <TableCell
                    className="max-w-32 truncate font-mono text-[11px] text-ink-muted"
                    title={e.config.seed}
                  >
                    {e.config.seed}
                  </TableCell>
                  <TableCell
                    className="font-mono text-[11px] text-ink-muted"
                    title={formatDateTime(e.startedAt)}
                  >
                    {e.startedAt ? timeAgo(e.startedAt) : "—"}
                  </TableCell>
                  <TableCell
                    className="font-mono text-[11px] text-ink-muted"
                    title={formatDateTime(e.endsAt)}
                  >
                    {e.endsAt ? timeAgo(e.endsAt) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">
                    {e.results ? (
                      <span className="text-ok">computed</span>
                    ) : (
                      <span className="text-ink-dim">pending</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
