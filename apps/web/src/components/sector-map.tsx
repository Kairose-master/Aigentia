"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { WorldDto } from "@aigentia/protocol";
import { objectiveColor, resourceColor } from "@/lib/colors";
import { formatNumber, formatXrp, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";

type Location = WorldDto["locations"][number];
type Deposit = WorldDto["resources"][number];
type Agent = WorldDto["agents"][number];

interface Hover {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

const W = 800;
const H = 520;
const PAD = 70;

function projector(
  locations: readonly Location[],
): (x: number, y: number) => { px: number; py: number } {
  const xs = locations.map((l) => l.x);
  const ys = locations.map((l) => l.y);
  const minX = Math.min(...xs, -1);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, -1);
  const maxY = Math.max(...ys, 1);
  const sx = (W - PAD * 2) / Math.max(1, maxX - minX);
  const sy = (H - PAD * 2) / Math.max(1, maxY - minY);
  const s = Math.min(sx, sy);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return (x, y) => ({ px: W / 2 + (x - cx) * s, py: H / 2 - (y - cy) * s });
}

/**
 * SVG map of the Genesis Sector: locations as nodes, resource deposits as rings sized by
 * quantity, agents as dots grouped per location, hover tooltips.
 */
export function SectorMap({
  world,
  compact = false,
  className,
}: {
  world: WorldDto | null;
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  const [hover, setHover] = useState<Hover | null>(null);
  const model = useMemo(() => {
    if (!world || world.locations.length === 0) return null;
    const project = projector(world.locations);
    const maxQty = Math.max(1, ...world.resources.map((r) => r.quantity));
    const depositsByLoc = new Map<string, Deposit[]>();
    for (const r of world.resources) {
      const list = depositsByLoc.get(r.locationId) ?? [];
      list.push(r);
      depositsByLoc.set(r.locationId, list);
    }
    const agentsByLoc = new Map<string, Agent[]>();
    for (const a of world.agents) {
      const list = agentsByLoc.get(a.locationId) ?? [];
      list.push(a);
      agentsByLoc.set(a.locationId, list);
    }
    const core = world.locations.find((l) => l.x === 0 && l.y === 0) ?? world.locations[0];
    return { project, maxQty, depositsByLoc, agentsByLoc, core };
  }, [world]);

  if (!world || !model) {
    return (
      <div className={cn("grid place-items-center", compact ? "h-56" : "h-[520px]", className)}>
        <span className="font-mono text-[11px] tracking-[0.2em] text-ink-muted uppercase">
          Sector map unavailable
        </span>
      </div>
    );
  }

  const { project, maxQty, depositsByLoc, agentsByLoc, core } = model;

  return (
    <div className={cn("relative", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Genesis Sector map"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <pattern id="sector-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1a222c" strokeWidth="1" />
          </pattern>
          <radialGradient id="sector-glow">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width={W} height={H} fill="url(#sector-grid)" />
        {/* lanes from the core to every outpost */}
        {core &&
          world.locations
            .filter((l) => l.id !== core.id)
            .map((l) => {
              const a = project(core.x, core.y);
              const b = project(l.x, l.y);
              return (
                <line
                  key={`lane-${l.id}`}
                  x1={a.px}
                  y1={a.py}
                  x2={b.px}
                  y2={b.py}
                  stroke="#253040"
                  strokeWidth="1"
                  strokeDasharray="4 6"
                />
              );
            })}
        {world.locations.map((loc) => {
          const { px, py } = project(loc.x, loc.y);
          const deposits = depositsByLoc.get(loc.id) ?? [];
          const agents = agentsByLoc.get(loc.id) ?? [];
          return (
            <g key={loc.id}>
              <circle cx={px} cy={py} r={compact ? 34 : 46} fill="url(#sector-glow)" />
              {deposits.map((d, i) => {
                const r = 14 + (d.quantity / maxQty) * (compact ? 22 : 34) + i * 3;
                return (
                  <circle
                    key={d.id}
                    cx={px}
                    cy={py}
                    r={r}
                    fill="none"
                    stroke={resourceColor(d.resourceType)}
                    strokeWidth={2}
                    strokeOpacity={0.85}
                    className="cursor-help"
                    onMouseEnter={() =>
                      setHover({
                        x: px,
                        y: py - r,
                        title: `${d.resourceType} deposit`,
                        lines: [
                          `${formatNumber(d.quantity)} units at ${loc.name}`,
                          `base price ${formatXrp(d.basePriceDrops)} XRP`,
                        ],
                      })
                    }
                  />
                );
              })}
              <circle
                cx={px}
                cy={py}
                r={6}
                fill="#0b0f14"
                stroke="#22d3ee"
                strokeWidth={1.5}
                className="cursor-help"
                onMouseEnter={() =>
                  setHover({
                    x: px,
                    y: py - 8,
                    title: loc.name,
                    lines: [
                      `(${loc.x}, ${loc.y}) · ${agents.length} agent${agents.length === 1 ? "" : "s"}`,
                      deposits.length > 0
                        ? deposits
                            .map((d) => `${d.resourceType} ${formatNumber(d.quantity)}`)
                            .join(" · ")
                        : "no deposits",
                    ],
                  })
                }
              />
              <text
                x={px}
                y={py + (compact ? 46 : 62)}
                textAnchor="middle"
                fontFamily="var(--font-geist-mono)"
                fontSize={compact ? 10 : 11}
                letterSpacing="0.14em"
                fill="#94a3b8"
              >
                {loc.name.toUpperCase()}
              </text>
              {agents.map((a, i) => {
                const n = agents.length;
                const ring = Math.floor(i / 12);
                const angle = ((i % 12) / Math.min(12, n - ring * 12)) * Math.PI * 2 - Math.PI / 2;
                const rad = 12 + ring * 9;
                const ax = px + Math.cos(angle) * rad;
                const ay = py + Math.sin(angle) * rad;
                return (
                  <Link key={a.id} href={`/agents/${a.id}`}>
                    <circle
                      cx={ax}
                      cy={ay}
                      r={a.status === "bankrupt" ? 2.5 : 3.5}
                      fill={a.status === "bankrupt" ? "#3f4c5c" : objectiveColor(a.objective)}
                      stroke="#05070a"
                      strokeWidth={1}
                      className="cursor-pointer"
                      onMouseEnter={() =>
                        setHover({
                          x: ax,
                          y: ay - 4,
                          title: a.name,
                          lines: [
                            `${humanize(a.objective)} · ${a.status}`,
                            `net worth ${formatXrp(a.netWorthDrops, { maxFraction: 2 })} XRP · rep ${a.reputation.toFixed(0)}`,
                          ],
                        })
                      }
                    />
                  </Link>
                );
              })}
            </g>
          );
        })}
        {hover && (
          <foreignObject
            x={Math.min(W - 230, Math.max(0, hover.x - 110))}
            y={Math.max(0, hover.y - 62)}
            width={230}
            height={60}
            pointerEvents="none"
          >
            <div className="rounded-sm border border-line-strong bg-panel-raised px-2 py-1 text-[11px] text-ink shadow-lg">
              <div className="font-mono text-[10px] tracking-[0.14em] text-ink-strong uppercase">
                {hover.title}
              </div>
              {hover.lines.map((l) => (
                <div key={l} className="truncate text-ink-muted">
                  {l}
                </div>
              ))}
            </div>
          </foreignObject>
        )}
      </svg>
      {!compact && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-[11px] text-ink-muted">
          <span className="eyebrow">Legend</span>
          {Object.entries({ ore: "ore", data: "data", energy: "energy", alloy: "alloy" }).map(
            ([k]) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block size-2.5 rounded-full border-2"
                  style={{ borderColor: resourceColor(k) }}
                />
                {k} deposit (ring ∝ quantity)
              </span>
            ),
          )}
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full bg-live" /> agent (colour = objective)
          </span>
        </div>
      )}
    </div>
  );
}
