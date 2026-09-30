"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useLive } from "@/components/live-provider";
import { LedgerBadge } from "@/components/ledger-badge";
import { formatNumber } from "@/lib/format";

const NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/", label: "Overview" },
  { href: "/world", label: "World" },
  { href: "/agents", label: "Agents" },
  { href: "/market", label: "Market" },
  { href: "/jobs", label: "Jobs" },
  { href: "/transactions", label: "Transactions" },
  { href: "/experiments", label: "Experiments" },
];

export function LivePill(): React.JSX.Element {
  const { connected } = useLive();
  return (
    <span
      data-testid="live-pill"
      data-state={connected ? "live" : "offline"}
      className={cn(
        "inline-flex h-6 items-center gap-2 rounded-full border px-2.5 font-mono text-[11px] tracking-[0.18em] uppercase",
        connected
          ? "border-live/40 bg-live/10 text-live"
          : "border-line-strong bg-panel text-ink-muted",
      )}
    >
      <span
        className={cn(
          "inline-block size-1.5 rounded-full",
          connected ? "bg-live live-dot" : "bg-ink-dim",
        )}
      />
      {connected ? "Live" : "Offline"}
    </span>
  );
}

export function TopBar(): React.JSX.Element {
  const pathname = usePathname();
  const { stats, ledger, network } = useLive();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-[rgba(5,7,10,0.88)] backdrop-blur">
      <div className="mx-auto flex h-12 max-w-[1600px] items-center gap-4 px-4">
        <Link href="/" className="group flex items-center gap-2.5" aria-label="Aigentia home">
          <span className="grid size-6 place-items-center rounded-sm border border-live/50 bg-live/10">
            <span className="size-2 rotate-45 bg-live" />
          </span>
          <span
            data-testid="wordmark"
            className="font-mono text-sm font-semibold tracking-[0.32em] text-ink-strong"
          >
            AIGENTIA
          </span>
        </Link>
        <LivePill />
        <div className="hidden items-center gap-1.5 font-mono text-[11px] text-ink-muted md:flex">
          <span className="uppercase tracking-[0.18em]">Tick</span>
          <span className="tnum text-ink-strong" data-testid="tick-counter">
            {stats ? formatNumber(stats.tick) : "—"}
          </span>
        </div>
        <LedgerBadge ledger={ledger} network={network} />
        <nav className="ml-auto flex items-center gap-0.5 overflow-x-auto" aria-label="Primary">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-sm px-2.5 py-1 font-mono text-[11px] tracking-[0.14em] uppercase transition-colors",
                  active
                    ? "bg-live/10 text-live"
                    : "text-ink-muted hover:bg-panel-raised hover:text-ink-strong",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
