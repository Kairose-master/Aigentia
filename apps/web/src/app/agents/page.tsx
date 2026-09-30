import Link from "next/link";
import { getAgents } from "@/lib/api";
import { Panel, PageHeader, OfflineBanner, EmptyState } from "@/components/panel";
import { Money } from "@/components/money";
import { StatusChip } from "@/components/status-chip";
import { ObjectiveBadge } from "@/components/objective-badge";
import { ReputationBar } from "@/components/reputation-bar";
import { AddressLink } from "@/components/address-link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { compareDropsDesc } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AgentsPage(): Promise<React.JSX.Element> {
  const result = await getAgents();
  const offline = result.error?.offline === true;
  const agents = [...(result.data ?? [])].sort((a, b) =>
    compareDropsDesc(a.netWorthDrops, b.netWorthDrops),
  );

  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle="Every agent owns an XRPL Testnet wallet and a budget policy. Balance is what the ledger says; net worth adds inventory at market bid."
        action={
          <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
            {agents.length} agents
          </span>
        }
      />
      {offline && <OfflineBanner />}
      <Panel eyebrow="Population" title="Agent roster">
        {agents.length === 0 ? (
          <EmptyState
            offline={offline}
            title="No agents have been created."
            detail="POST /api/admin/agents creates one; experiments create many."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="text-[10px] tracking-[0.14em] text-ink-muted uppercase">
                <TableHead>Name</TableHead>
                <TableHead>Objective</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Net worth</TableHead>
                <TableHead>Reputation</TableHead>
                <TableHead>Brain</TableHead>
                <TableHead>Wallet</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link
                      href={`/agents/${a.id}`}
                      className="font-mono text-xs font-medium text-ink-strong hover:text-live"
                    >
                      {a.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <ObjectiveBadge objective={a.objective} />
                  </TableCell>
                  <TableCell>
                    <StatusChip status={a.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money drops={a.balanceDrops} maxFraction={2} className="text-xs" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money drops={a.netWorthDrops} maxFraction={2} className="text-xs" />
                  </TableCell>
                  <TableCell>
                    <ReputationBar value={a.reputation} />
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-ink-muted">{a.brain}</TableCell>
                  <TableCell>
                    <AddressLink address={a.walletAddress} explorerUrl={a.explorerUrl} />
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
