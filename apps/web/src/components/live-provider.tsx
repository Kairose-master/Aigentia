"use client";

import type { StatsDto, WorldEvent } from "@aigentia/protocol";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { eventStreamUrl } from "@/lib/api";
import { eventKey, parseSseEnvelope } from "@/lib/sse";
import type { LedgerKind } from "@/lib/format";

export const LIVE_EVENT_CAP = 200;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

export interface LiveStats {
  readonly agents: number;
  readonly transactions: number;
  readonly servicePurchases: number;
  readonly activeJobs: number;
  readonly volumeDrops: string;
  readonly tick: number;
}

export interface LiveState {
  /** True while the EventSource is open. */
  readonly connected: boolean;
  /** True once the API answered at least once (server fetch or stream). */
  readonly apiReachable: boolean;
  readonly stats: LiveStats | null;
  readonly ledger: LedgerKind | null;
  readonly network: string | null;
  /** Newest first, capped at LIVE_EVENT_CAP. */
  readonly events: readonly WorldEvent[];
  readonly lastHeartbeatAt: string | null;
  readonly lastEventAt: string | null;
}

const LiveContext = createContext<LiveState | null>(null);

function statsFromDto(dto: StatsDto | null): LiveStats | null {
  if (!dto) return null;
  return {
    agents: dto.agents,
    transactions: dto.transactions,
    servicePurchases: dto.servicePurchases,
    activeJobs: dto.activeJobs,
    volumeDrops: dto.volumeDrops,
    tick: dto.tick,
  };
}

/** Prepend new events (newest first), de-duplicate, cap the buffer. */
export function mergeEvents(
  existing: readonly WorldEvent[],
  incoming: readonly WorldEvent[],
  cap = LIVE_EVENT_CAP,
): WorldEvent[] {
  const seen = new Set<string>();
  const out: WorldEvent[] = [];
  const push = (e: WorldEvent): void => {
    const key = eventKey(e);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  // Incoming are assumed oldest→newest when they come as a batch; reverse so newest lands first.
  for (let i = incoming.length - 1; i >= 0; i -= 1) {
    const e = incoming[i];
    if (e) push(e);
  }
  for (const e of existing) push(e);
  return out.slice(0, cap);
}

export function LiveProvider({
  initialStats,
  children,
}: {
  initialStats: StatsDto | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const [connected, setConnected] = useState(false);
  const [streamStats, setStreamStats] = useState<LiveStats | null>(null);
  const [events, setEvents] = useState<readonly WorldEvent[]>([]);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [streamSeen, setStreamSeen] = useState(false);
  const attempts = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const handle = (raw: string, fallbackChannel?: string): void => {
      const envelope = parseSseEnvelope(raw, fallbackChannel);
      if (!envelope) return;
      setStreamSeen(true);
      switch (envelope.channel) {
        case "event":
          setEvents((prev) => mergeEvents(prev, [envelope.data]));
          setLastEventAt(envelope.data.createdAt);
          break;
        case "stats":
          setStreamStats(envelope.data);
          break;
        case "heartbeat":
          setLastHeartbeatAt(envelope.data.at);
          break;
      }
    };

    const connect = (): void => {
      if (disposed) return;
      source = new EventSource(eventStreamUrl());
      source.onopen = () => {
        attempts.current = 0;
        setConnected(true);
      };
      source.onmessage = (msg: MessageEvent<string>) => handle(msg.data);
      for (const name of ["event", "stats", "heartbeat"] as const) {
        source.addEventListener(name, (msg: Event) => {
          if (msg instanceof MessageEvent && typeof msg.data === "string") handle(msg.data, name);
        });
      }
      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempts.current);
        attempts.current += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, []);

  // Stream stats win once seen; until then the server-rendered snapshot is the truth.
  const stats = streamStats ?? statsFromDto(initialStats);

  const value = useMemo<LiveState>(
    () => ({
      connected,
      apiReachable: initialStats !== null || streamSeen,
      stats,
      ledger: initialStats?.ledger ?? null,
      network: initialStats?.network ?? null,
      events,
      lastHeartbeatAt,
      lastEventAt,
    }),
    [connected, initialStats, streamSeen, stats, events, lastHeartbeatAt, lastEventAt],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

const OFFLINE: LiveState = {
  connected: false,
  apiReachable: false,
  stats: null,
  ledger: null,
  network: null,
  events: [],
  lastHeartbeatAt: null,
  lastEventAt: null,
};

export function useLive(): LiveState {
  return useContext(LiveContext) ?? OFFLINE;
}
