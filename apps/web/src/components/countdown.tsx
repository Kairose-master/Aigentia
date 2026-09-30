"use client";

import { useSyncExternalStore } from "react";
import { formatCountdown } from "@/lib/format";

function subscribe(onChange: () => void): () => void {
  const t = setInterval(onChange, 1000);
  return () => clearInterval(t);
}

const getSnapshot = (): number => Math.floor(Date.now() / 1000);
const getServerSnapshot = (): number | null => null;

/** Live countdown to an ISO timestamp; shows "ended" once elapsed. Hydration-safe. */
export function Countdown({
  endsAt,
  className,
}: {
  endsAt: string | null;
  className?: string;
}): React.JSX.Element {
  const nowSeconds = useSyncExternalStore<number | null>(subscribe, getSnapshot, getServerSnapshot);
  if (!endsAt) return <span className={className}>—</span>;
  const end = new Date(endsAt).getTime();
  if (Number.isNaN(end)) return <span className={className}>—</span>;
  if (nowSeconds === null) return <span className={className}>--:--:--</span>;
  const remaining = end - nowSeconds * 1000;
  return (
    <span className={className} data-testid="countdown">
      {remaining <= 0 ? "ended" : formatCountdown(remaining)}
    </span>
  );
}
