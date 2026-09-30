"use client";

import { useSyncExternalStore } from "react";
import { timeAgo } from "@/lib/format";

const subscribeNoop = (): (() => void) => () => {};

/**
 * Relative time that is safe to hydrate: the server and the client compute "x ago" at
 * different instants, so React is told to accept the text mismatch, and a post-hydration
 * re-render (via useSyncExternalStore's differing server/client snapshots) refreshes the value.
 */
export function TimeAgo({
  iso,
  now,
  className,
}: {
  iso: string | Date | null | undefined;
  now?: Date;
  className?: string;
}): React.JSX.Element {
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  const reference = now ?? (mounted ? new Date() : new Date(0));
  return (
    <span className={className} suppressHydrationWarning>
      {mounted || now ? timeAgo(iso, reference) : timeAgo(iso, new Date())}
    </span>
  );
}
