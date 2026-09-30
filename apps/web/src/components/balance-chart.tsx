"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AgentProfileDto } from "@aigentia/protocol";
import { dropsToXrpNumber, formatNumber } from "@/lib/format";

type Point = { tick: number; balance: number; netWorth: number };

/** Balance vs net worth over ticks (XRP). Single axis, two series, legend + crosshair tooltip. */
export function BalanceChart({
  history,
  height = 220,
}: {
  history: AgentProfileDto["balanceHistory"];
  height?: number;
}): React.JSX.Element {
  const data: Point[] = [...history]
    .sort((a, b) => a.tick - b.tick)
    .map((h) => ({
      tick: h.tick,
      balance: dropsToXrpNumber(h.balanceDrops),
      netWorth: dropsToXrpNumber(h.netWorthDrops),
    }));

  if (data.length === 0) {
    return (
      <div className="grid place-items-center" style={{ height }}>
        <span className="font-mono text-[11px] tracking-[0.2em] text-ink-muted uppercase">
          No snapshots yet
        </span>
      </div>
    );
  }

  return (
    <div style={{ height }} data-testid="balance-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#1a222c" vertical={false} />
          <XAxis
            dataKey="tick"
            stroke="#3f4c5c"
            tick={{ fill: "#64748b", fontSize: 10, fontFamily: "var(--font-geist-mono)" }}
            tickLine={false}
            axisLine={{ stroke: "#1a222c" }}
            tickFormatter={(v: number) => `t${v}`}
          />
          <YAxis
            stroke="#3f4c5c"
            width={56}
            tick={{ fill: "#64748b", fontSize: 10, fontFamily: "var(--font-geist-mono)" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => formatNumber(v, 1)}
          />
          <Tooltip
            cursor={{ stroke: "#253040", strokeDasharray: "3 3" }}
            contentStyle={{
              background: "#0f151c",
              border: "1px solid #253040",
              borderRadius: 4,
              fontFamily: "var(--font-geist-mono)",
              fontSize: 11,
              color: "#cbd5e1",
            }}
            labelStyle={{ color: "#64748b" }}
            labelFormatter={(label) => `tick ${String(label)}`}
            formatter={(value, name) => [`${formatNumber(Number(value), 4)} XRP`, String(name)]}
          />
          <Legend
            verticalAlign="top"
            align="right"
            iconType="plainline"
            wrapperStyle={{
              fontFamily: "var(--font-geist-mono)",
              fontSize: 10,
              color: "#64748b",
              paddingBottom: 4,
            }}
          />
          <Line
            type="monotone"
            dataKey="balance"
            name="balance"
            stroke="#22d3ee"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="netWorth"
            name="net worth"
            stroke="#a78bfa"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
