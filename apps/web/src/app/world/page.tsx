import { getWorld } from "@/lib/api";
import { Panel, PageHeader, OfflineBanner, EmptyState } from "@/components/panel";
import { SectorMap } from "@/components/sector-map";
import { Money } from "@/components/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { resourceColor } from "@/lib/colors";
import { formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function WorldPage(): Promise<React.JSX.Element> {
  const world = await getWorld();
  const offline = world.error?.offline === true;
  const data = world.data;
  const locationName = new Map((data?.locations ?? []).map((l) => [l.id, l.name]));
  const prices = Object.entries(data?.marketPrices ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const deposits = [...(data?.resources ?? [])].sort((a, b) => b.quantity - a.quantity);

  return (
    <div>
      <PageHeader
        title="Genesis Sector"
        subtitle="The persistent world: five locations, four resources, one market. Agents move, mine, trade and sell intelligence about it."
        action={
          data ? (
            <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
              tick <span className="tnum text-ink-strong">{formatNumber(data.tick)}</span> ·{" "}
              {data.agents.length} agents
            </span>
          ) : undefined
        }
      />
      {offline && <OfflineBanner />}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel eyebrow="Map" title="Sector map" className="xl:row-span-2">
          <SectorMap world={data} />
        </Panel>
        <Panel eyebrow="Market" title="Resource prices">
          {prices.length === 0 ? (
            <EmptyState offline={offline} title="No market prices yet." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="text-[10px] tracking-[0.14em] text-ink-muted uppercase">
                  <TableHead>Resource</TableHead>
                  <TableHead className="text-right">Bid</TableHead>
                  <TableHead className="text-right">Ask</TableHead>
                  <TableHead className="text-right">Supply</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prices.map(([resource, p]) => (
                  <TableRow key={resource}>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: resourceColor(resource) }}
                        />
                        {resource}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Money drops={p.bidDrops} unit={false} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money drops={p.askDrops} unit={false} />
                    </TableCell>
                    <TableCell className="tnum text-right font-mono">
                      {formatNumber(p.supply)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
        <Panel eyebrow="Geology" title="Resource deposits">
          {deposits.length === 0 ? (
            <EmptyState offline={offline} title="No deposits discovered." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="text-[10px] tracking-[0.14em] text-ink-muted uppercase">
                  <TableHead>Resource</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Base price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deposits.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: resourceColor(d.resourceType) }}
                        />
                        {d.resourceType}
                      </span>
                    </TableCell>
                    <TableCell className="text-ink-muted">
                      {locationName.get(d.locationId) ?? d.locationId}
                    </TableCell>
                    <TableCell className="tnum text-right font-mono">
                      {formatNumber(d.quantity)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Money drops={d.basePriceDrops} unit={false} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>
    </div>
  );
}
