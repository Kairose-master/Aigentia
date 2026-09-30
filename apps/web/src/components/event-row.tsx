import Link from "next/link";
import type { WorldEvent } from "@aigentia/protocol";
import { cn } from "@/lib/utils";
import { TONE_DOT, TONE_TEXT, eventTone } from "@/lib/colors";
import { formatXrp, timeAgo, type LedgerKind } from "@/lib/format";
import { TxLink } from "@/components/address-link";

export function EventRow({
  event,
  ledger,
  now,
  dense = false,
}: {
  event: WorldEvent;
  ledger: LedgerKind | null;
  now?: Date;
  dense?: boolean;
}): React.JSX.Element {
  const tone = eventTone(event.type);
  return (
    <li
      className={cn(
        "grid grid-cols-[8px_1fr_auto] items-start gap-x-2.5 border-b border-line/70 px-3 last:border-0",
        dense ? "py-1.5" : "py-2",
      )}
    >
      <span className={cn("mt-1.5 size-2 rounded-full", TONE_DOT[tone])} aria-hidden />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span
            className={cn("font-mono text-[10px] tracking-[0.14em] uppercase", TONE_TEXT[tone])}
          >
            {event.type}
          </span>
          <span className="font-mono text-[10px] text-ink-dim">tick {event.tick}</span>
          {event.amountDrops && (
            <span className="tnum font-mono text-[11px] text-ink-strong">
              {formatXrp(event.amountDrops)} <span className="text-ink-muted">XRP</span>
            </span>
          )}
          {event.txHash && <TxLink txHash={event.txHash} ledger={ledger} />}
        </div>
        <p className={cn("text-ink", dense ? "truncate text-xs" : "text-sm")}>
          {event.agentId ? (
            <Link href={`/agents/${event.agentId}`} className="hover:text-live">
              {event.message}
            </Link>
          ) : (
            event.message
          )}
        </p>
      </div>
      <time
        dateTime={event.createdAt}
        className="tnum font-mono text-[10px] whitespace-nowrap text-ink-muted"
      >
        {timeAgo(event.createdAt, now)}
      </time>
    </li>
  );
}
