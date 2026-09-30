"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type { ExperimentResults } from "@aigentia/protocol";
import { OBJECTIVE_ORDER, objectiveColor } from "@/lib/colors";
import { dropsToXrpNumber, formatNumber, formatXrp, humanize } from "@/lib/format";

type Graph = ExperimentResults["networkGraph"];

interface Node extends SimulationNodeDatum {
  id: string;
  name: string;
  objective: string;
  status: string;
  netWorthDrops: string;
  r: number;
}

interface Edge extends SimulationLinkDatum<Node> {
  count: number;
  volumeDrops: string;
  w: number;
}

interface Laid {
  nodes: Node[];
  edges: Array<Edge & { source: Node; target: Node }>;
}

const W = 900;
const H = 560;

function isNode(v: Node | string | number): v is Node {
  return typeof v === "object";
}

/** Agent-to-agent payment network: node size ∝ √net worth, edge width ∝ log volume, colour = objective. */
export function NetworkGraph({ graph }: { graph: Graph }): React.JSX.Element {
  const [hover, setHover] = useState<string | null>(null);

  const prepared = useMemo(() => {
    const maxWorth = Math.max(1, ...graph.nodes.map((n) => dropsToXrpNumber(n.netWorthDrops)));
    const nodes: Node[] = graph.nodes.map((n) => ({
      ...n,
      r: 6 + Math.sqrt(Math.max(0, dropsToXrpNumber(n.netWorthDrops)) / maxWorth) * 22,
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const maxVol = Math.max(1, ...graph.edges.map((e) => dropsToXrpNumber(e.volumeDrops)));
    const edges: Edge[] = graph.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
      .map((e) => ({
        source: e.from,
        target: e.to,
        count: e.count,
        volumeDrops: e.volumeDrops,
        w: 1 + (Math.log1p(dropsToXrpNumber(e.volumeDrops)) / Math.log1p(maxVol)) * 5,
      }));
    return { nodes, edges };
  }, [graph]);

  // Layout is a pure, deterministic function of the graph: run the simulation to rest synchronously.
  const laid = useMemo<Laid>(() => {
    if (prepared.nodes.length === 0) return { nodes: [], edges: [] };
    const nodes = prepared.nodes.map((n) => ({ ...n }));
    const edges = prepared.edges.map((e) => ({ ...e }));
    const sim = forceSimulation<Node, Edge>(nodes)
      .force("charge", forceManyBody<Node>().strength(-220))
      .force(
        "link",
        forceLink<Node, Edge>(edges)
          .id((d) => d.id)
          .distance(110)
          .strength(0.6),
      )
      .force("center", forceCenter<Node>(W / 2, H / 2))
      .force(
        "collide",
        forceCollide<Node>().radius((d) => d.r + 6),
      )
      .stop();
    for (let i = 0; i < 300; i += 1) sim.tick();
    const resolved: Laid["edges"] = [];
    for (const e of edges) {
      if (isNode(e.source) && isNode(e.target)) {
        resolved.push({ ...e, source: e.source, target: e.target });
      }
    }
    for (const n of nodes) {
      n.x = Math.max(n.r, Math.min(W - n.r, n.x ?? W / 2));
      n.y = Math.max(n.r, Math.min(H - n.r, n.y ?? H / 2));
    }
    return { nodes, edges: resolved };
  }, [prepared]);

  if (graph.nodes.length === 0) {
    return (
      <div className="grid h-64 place-items-center">
        <span className="font-mono text-[11px] tracking-[0.2em] text-ink-muted uppercase">
          No agent-to-agent payments
        </span>
      </div>
    );
  }

  const hovered = laid.nodes.find((n) => n.id === hover) ?? null;
  const objectives = OBJECTIVE_ORDER.filter((o) => graph.nodes.some((n) => n.objective === o));
  const others = graph.nodes.some(
    (n) => !(OBJECTIVE_ORDER as readonly string[]).includes(n.objective),
  );

  return (
    <div data-testid="network-graph">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Agent payment network"
        onMouseLeave={() => setHover(null)}
      >
        <rect width={W} height={H} fill="transparent" />
        {laid.edges.map((e, i) => {
          const dim = hover !== null && e.source.id !== hover && e.target.id !== hover;
          return (
            <line
              key={`e-${i}`}
              x1={e.source.x ?? 0}
              y1={e.source.y ?? 0}
              x2={e.target.x ?? 0}
              y2={e.target.y ?? 0}
              stroke="#22d3ee"
              strokeOpacity={dim ? 0.08 : 0.45}
              strokeWidth={e.w}
              strokeLinecap="round"
            >
              <title>{`${e.source.name} → ${e.target.name}: ${formatNumber(e.count)} payments, ${formatXrp(e.volumeDrops)} XRP`}</title>
            </line>
          );
        })}
        {laid.nodes.map((n) => {
          const dim =
            hover !== null &&
            n.id !== hover &&
            !laid.edges.some(
              (e) =>
                (e.source.id === hover && e.target.id === n.id) ||
                (e.target.id === hover && e.source.id === n.id),
            );
          return (
            <Link key={n.id} href={`/agents/${n.id}`}>
              <g
                transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                opacity={dim ? 0.25 : 1}
                onMouseEnter={() => setHover(n.id)}
                className="cursor-pointer"
              >
                <circle
                  r={n.r}
                  fill={objectiveColor(n.objective)}
                  fillOpacity={n.status === "bankrupt" ? 0.25 : 0.85}
                  stroke="#05070a"
                  strokeWidth={2}
                />
                {n.status === "bankrupt" && (
                  <circle
                    r={n.r}
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                  />
                )}
                {n.r >= 12 && (
                  <text
                    textAnchor="middle"
                    dy={n.r + 12}
                    fontFamily="var(--font-geist-mono)"
                    fontSize={10}
                    fill="#94a3b8"
                  >
                    {n.name}
                  </text>
                )}
              </g>
            </Link>
          );
        })}
        {hovered && (
          <foreignObject
            x={Math.min(W - 240, Math.max(0, (hovered.x ?? 0) - 120))}
            y={Math.max(0, (hovered.y ?? 0) - hovered.r - 64)}
            width={240}
            height={60}
            pointerEvents="none"
          >
            <div className="rounded-sm border border-line-strong bg-panel-raised px-2 py-1 text-[11px] text-ink shadow-lg">
              <div className="font-mono text-[10px] tracking-[0.14em] text-ink-strong uppercase">
                {hovered.name}
              </div>
              <div className="text-ink-muted">
                {humanize(hovered.objective)} · {hovered.status}
              </div>
              <div className="tnum font-mono text-ink">
                {formatXrp(hovered.netWorthDrops, { maxFraction: 2 })} XRP net worth
              </div>
            </div>
          </foreignObject>
        )}
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-[11px] text-ink-muted">
        <span className="eyebrow">Objective</span>
        {objectives.map((o) => (
          <span key={o} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: objectiveColor(o) }}
            />
            {humanize(o)}
          </span>
        ))}
        {others && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: objectiveColor(null) }}
            />
            other
          </span>
        )}
        <span className="ml-auto">node ∝ √net worth · edge ∝ log volume · dashed = bankrupt</span>
      </div>
    </div>
  );
}
