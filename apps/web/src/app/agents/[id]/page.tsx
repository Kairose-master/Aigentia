import Link from "next/link";
import { getAgent } from "@/lib/api";
import { Panel, PageHeader, OfflineBanner, EmptyState } from "@/components/panel";
import { Money } from "@/components/money";
import { StatusChip } from "@/components/status-chip";
import { ObjectiveBadge } from "@/components/objective-badge";
import { ReputationBar } from "@/components/reputation-bar";
import { AddressLink } from "@/components/address-link";
import { BalanceChart } from "@/components/balance-chart";
import { AgentTabs } from "@/components/agent-tabs";
import { formatXrp, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-l border-line px-3 first:border-0 first:pl-0">
      <span className="eyebrow">{label}</span>
      <span className="text-sm text-ink-strong">{children}</span>
    </div>
  );
}

export default async function AgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const result = await getAgent(id);

  if (result.error) {
    const offline = result.error.offline;
    return (
      <div>
        <PageHeader title="Agent" subtitle={id} />
        {offline && <OfflineBanner />}
        <Panel>
          <EmptyState
            offline={offline}
            title={
              result.error.code === "NOT_FOUND"
                ? `No agent with id ${id}.`
                : "Agent profile unavailable."
            }
            detail={result.error.message}
          />
          <div className="border-t border-line px-4 py-3">
            <Link
              href="/agents"
              className="font-mono text-[11px] tracking-[0.14em] text-live uppercase"
            >
              ← all agents
            </Link>
          </div>
        </Panel>
      </div>
    );
  }

  const { agent, budgetPolicy } = result.data;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={agent.name}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-3">
            <ObjectiveBadge objective={agent.objective} />
            <StatusChip status={agent.status} />
            <span className="font-mono text-[11px] text-ink-muted">brain {agent.brain}</span>
            <span className="font-mono text-[11px] text-ink-muted">
              created {timeAgo(agent.createdAt)}
            </span>
            <span className="font-mono text-[11px] text-ink-muted">at {agent.locationId}</span>
          </span>
        }
        action={
          <Link
            href="/agents"
            className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase hover:text-live"
          >
            ← roster
          </Link>
        }
      />
      <div className="grid gap-y-3 rounded-md border border-line bg-panel p-3 sm:grid-cols-2 lg:grid-cols-6">
        <Fact label="Wallet">
          <AddressLink address={agent.walletAddress} explorerUrl={agent.explorerUrl} full />
        </Fact>
        <Fact label="XRPL balance">
          <Money drops={agent.balanceDrops} />
        </Fact>
        <Fact label="Net worth">
          <Money drops={agent.netWorthDrops} tone="live" />
        </Fact>
        <Fact label="Reputation">
          <ReputationBar value={agent.reputation} />
        </Fact>
        <Fact label="Status">
          <StatusChip status={agent.status} />
        </Fact>
        <Fact label="Brain">
          <span className="font-mono text-xs">{agent.brain}</span>
        </Fact>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel eyebrow="Trajectory" title="Balance & net worth (XRP)" bodyClassName="p-2">
          <BalanceChart history={result.data.balanceHistory} />
        </Panel>
        <Panel eyebrow="Safety envelope" title="Budget policy" bodyClassName="px-3 py-2 text-xs">
          <dl className="grid grid-cols-[1fr_auto] gap-y-1.5">
            <dt className="text-ink-muted">max / action</dt>
            <dd className="tnum text-right font-mono">
              {formatXrp(budgetPolicy.maxSpendPerActionDrops)} XRP
            </dd>
            <dt className="text-ink-muted">max / hour</dt>
            <dd className="tnum text-right font-mono">
              {formatXrp(budgetPolicy.maxSpendPerHourDrops)} XRP
            </dd>
            <dt className="text-ink-muted">max / day</dt>
            <dd className="tnum text-right font-mono">
              {formatXrp(budgetPolicy.maxDailySpendDrops)} XRP
            </dd>
            <dt className="text-ink-muted">minimum balance</dt>
            <dd className="tnum text-right font-mono">
              {formatXrp(budgetPolicy.minimumBalanceDrops)} XRP
            </dd>
            <dt className="text-ink-muted">assets</dt>
            <dd className="text-right font-mono">{budgetPolicy.allowedAssets.join(", ")}</dd>
            <dt className="text-ink-muted">service categories</dt>
            <dd className="text-right font-mono">
              {budgetPolicy.allowedServiceCategories.join(", ")}
            </dd>
          </dl>
          <p className="mt-3 border-t border-line pt-2 text-[11px] text-ink-muted">
            Enforced by the PolicyEngine before every PaymentIntent. Denied intents are recorded and
            never reach the ledger.
          </p>
        </Panel>
      </div>

      <Panel eyebrow="Ledger of mind" title="Activity" bodyClassName="p-3">
        <AgentTabs profile={result.data} />
      </Panel>
    </div>
  );
}
