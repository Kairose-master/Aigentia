"use client";

import type { WorldEvent } from "@aigentia/protocol";
import { useEffect, useMemo, useState } from "react";
import { LIVE_EVENT_CAP, mergeEvents, useLive } from "@/components/live-provider";
import { EventRow } from "@/components/event-row";
import { EmptyState } from "@/components/panel";
import { cn } from "@/lib/utils";

const DECISION_TYPES = new Set(["DECISION_MADE", "ACTION_INVALID", "ACTION_REJECTED"]);

/** Re-render relative timestamps every 15s without touching the data. */
function useClock(intervalMs = 15_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * Live event feed: seeded from GET /api/events, then prepended from the SSE stream.
 * Newest first, capped at LIVE_EVENT_CAP, type-coloured, tx hashes linked.
 */
export function LiveFeed({
  initial,
  offline,
  filter,
  dense = false,
  cap = LIVE_EVENT_CAP,
  className,
}: {
  initial: readonly WorldEvent[];
  offline: boolean;
  /** "decisions" shows only decision-trace events. */
  filter?: "decisions";
  dense?: boolean;
  cap?: number;
  className?: string;
}): React.JSX.Element {
  const live = useLive();
  const now = useClock();
  const events = useMemo(() => {
    // `initial` is oldest→newest from the API page or already newest-first; normalise by createdAt.
    const seeded = [...initial].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const merged = mergeEvents(live.events, seeded, LIVE_EVENT_CAP);
    const filtered =
      filter === "decisions" ? merged.filter((e) => DECISION_TYPES.has(e.type)) : merged;
    return filtered.slice(0, cap);
  }, [initial, live.events, filter, cap]);

  if (events.length === 0) {
    return (
      <EmptyState
        offline={offline && !live.connected}
        title={filter === "decisions" ? "No decisions recorded yet." : "No events yet."}
        detail={
          offline && !live.connected
            ? "Start the API and worker; the feed connects automatically."
            : "Events appear here the moment the simulation ticks."
        }
      />
    );
  }
  return (
    <ul
      data-testid={filter === "decisions" ? "decision-feed" : "live-feed"}
      className={cn("divide-y-0", className)}
    >
      {events.map((e, i) => (
        <EventRow
          key={e.id !== undefined ? `id-${e.id}` : `k-${i}-${e.createdAt}`}
          event={e}
          ledger={live.ledger}
          now={now}
          dense={dense}
        />
      ))}
    </ul>
  );
}
