import type { SnapshotMeta } from "@/lib/snapshot";
import { formatDateTime } from "@/lib/format";

/** Always-visible notice that the dashboard shows a recorded run, not a live economy. */
export function SnapshotBanner({ meta }: { meta: SnapshotMeta }): React.JSX.Element {
  return (
    <div
      data-testid="snapshot-banner"
      className="border-b border-warn/30 bg-warn/[0.07] px-4 py-2 text-center text-xs text-ink"
    >
      <span className="font-mono tracking-[0.18em] text-warn uppercase">Recorded snapshot</span>
      <span className="text-ink-muted">
        {" "}
        · captured {formatDateTime(meta.recordedAt)} from a real {meta.network} run · every
        transaction links to the public XRPL Testnet explorer · the live simulation is not connected
        to this deployment
      </span>
    </div>
  );
}
