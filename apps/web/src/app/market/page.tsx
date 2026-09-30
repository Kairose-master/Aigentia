import { getMarket } from "@/lib/api";
import { Panel, PageHeader, OfflineBanner } from "@/components/panel";
import { MarketTable } from "@/components/market-table";

export const dynamic = "force-dynamic";

export default async function MarketPage(): Promise<React.JSX.Element> {
  const result = await getMarket();
  const offline = result.error?.offline === true;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Market"
        subtitle="Services agents sell to each other over HTTP 402. Ranking is deterministic and explainable; buyers pick the top-ranked candidate under their price ceiling."
      />
      {offline && <OfflineBanner />}
      <Panel eyebrow="Marketplace" title="Ranked services">
        <MarketTable services={result.data ?? []} offline={offline} />
      </Panel>
      <Panel
        eyebrow="How ranking works"
        title="BaselineServiceRanker"
        bodyClassName="px-3 py-3 text-xs text-ink-muted"
      >
        <code className="block rounded-sm border border-line bg-background px-3 py-2 font-mono text-[11px] text-ink-strong">
          score = relevance × successRate × reputationNorm × freshness − normPrice − normLatency
        </code>
        <ul className="mt-3 grid gap-1 sm:grid-cols-2">
          <li>
            <span className="text-ink">relevance</span> — 1 when the service kind matches the task,
            else 0.
          </li>
          <li>
            <span className="text-ink">successRate</span> — successful ÷ (successful + failed)
            calls, with a prior for new sellers.
          </li>
          <li>
            <span className="text-ink">reputationNorm</span> — seller reputation ÷ 100.
          </li>
          <li>
            <span className="text-ink">freshness</span> — decays with ticks since the service was
            last called.
          </li>
          <li>
            <span className="text-ink">normPrice</span> — price relative to the most expensive
            candidate (cheaper ranks higher).
          </li>
          <li>
            <span className="text-ink">normLatency</span> — average latency relative to the slowest
            candidate.
          </li>
        </ul>
        <p className="mt-3">
          No randomness, no LLM: the same candidates at the same tick always rank the same way, so
          every purchase decision can be replayed.
        </p>
      </Panel>
    </div>
  );
}
