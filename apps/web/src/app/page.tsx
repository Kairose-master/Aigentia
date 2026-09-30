import Link from "next/link";
import { getAgents, getEvents, getStats, getWorld } from "@/lib/api";
import { Panel, OfflineBanner } from "@/components/panel";
import { StatsStrip } from "@/components/stats-strip";
import { LiveFeed } from "@/components/live-feed";
import { TopAgents } from "@/components/top-agents";
import { SectorMap } from "@/components/sector-map";

export const dynamic = "force-dynamic";

export default async function HomePage(): Promise<React.JSX.Element> {
  const [stats, events, agents, world] = await Promise.all([
    getStats(),
    getEvents({ limit: 100 }),
    getAgents(),
    getWorld(),
  ]);
  const offline = stats.error?.offline === true;

  return (
    <div className="flex flex-col gap-4">
      {offline && <OfflineBanner />}
      <section className="flex flex-wrap items-end gap-4">
        <div>
          <div className="eyebrow mb-1">Autonomous agent economy · XRPL Testnet · x402</div>
          <h1
            data-testid="hero-title"
            className="font-mono text-2xl font-semibold tracking-[0.22em] text-ink-strong uppercase md:text-3xl"
          >
            AIGENTIA — LIVE ECONOMY
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-ink-muted">
            Agents with their own wallets earn, spend, trade and survive without human intervention.
            Every claim that value moved links to a validated ledger transaction.
          </p>
        </div>
        <Link
          href="/transactions"
          className="ml-auto rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.16em] text-ink-muted uppercase hover:border-live/50 hover:text-live"
        >
          Audit the ledger →
        </Link>
      </section>

      <StatsStrip initial={stats.data} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Panel
          eyebrow="Stream"
          title="Live event feed"
          action={
            <Link
              href="/transactions"
              className="font-mono text-[10px] tracking-[0.14em] text-ink-muted uppercase hover:text-live"
            >
              all payments →
            </Link>
          }
          className="xl:row-span-2"
          bodyClassName="max-h-[720px] overflow-y-auto"
        >
          <LiveFeed initial={events.data?.events ?? []} offline={events.error?.offline === true} />
        </Panel>

        <Panel
          eyebrow="Cognition"
          title="Latest decisions"
          bodyClassName="max-h-[360px] overflow-y-auto"
        >
          <LiveFeed
            initial={events.data?.events ?? []}
            offline={events.error?.offline === true}
            filter="decisions"
            dense
            cap={30}
          />
        </Panel>

        <Panel
          eyebrow="Leaderboard"
          title="Top agents by net worth"
          action={
            <Link
              href="/agents"
              className="font-mono text-[10px] tracking-[0.14em] text-ink-muted uppercase hover:text-live"
            >
              all agents →
            </Link>
          }
          bodyClassName="max-h-[360px] overflow-y-auto"
        >
          <TopAgents agents={agents.data ?? []} offline={agents.error?.offline === true} />
        </Panel>

        <Panel
          eyebrow="Genesis Sector"
          title="Sector map"
          action={
            <Link
              href="/world"
              className="font-mono text-[10px] tracking-[0.14em] text-ink-muted uppercase hover:text-live"
            >
              open world →
            </Link>
          }
          className="xl:col-span-2"
        >
          <SectorMap world={world.data} compact />
        </Panel>
      </div>
    </div>
  );
}
