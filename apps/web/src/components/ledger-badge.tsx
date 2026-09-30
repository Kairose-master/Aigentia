import { cn } from "@/lib/utils";
import type { LedgerKind } from "@/lib/format";

export function LedgerBadge({
  ledger,
  network,
  className,
}: {
  ledger: LedgerKind | null | undefined;
  network?: string | null;
  className?: string;
}): React.JSX.Element {
  const label = ledger === "mock" ? "MOCK" : ledger === "testnet" ? "TESTNET" : "NO LEDGER";
  return (
    <span
      data-testid="ledger-badge"
      title={network ? `network ${network}` : undefined}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 font-mono text-[11px] tracking-[0.18em] uppercase",
        ledger === "mock"
          ? "border-warn/40 bg-warn/10 text-warn"
          : ledger === "testnet"
            ? "border-ok/40 bg-ok/10 text-ok"
            : "border-line-strong bg-panel text-ink-muted",
        className,
      )}
    >
      <span className="text-[9px] opacity-70">XRPL</span>
      {label}
    </span>
  );
}

/** Tiny inline "MOCK" marker for individual items produced by the [MOCK] ledger. */
export function MockBadge({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex h-4 items-center rounded-sm border border-warn/40 bg-warn/10 px-1 font-mono text-[9px] tracking-[0.16em] text-warn uppercase",
        className,
      )}
      title="Produced by the in-process mock ledger; no on-chain transaction exists."
    >
      Mock
    </span>
  );
}
