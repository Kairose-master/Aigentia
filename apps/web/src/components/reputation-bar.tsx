import { cn } from "@/lib/utils";

/** 0..100 reputation as a thin bar with the value beside it. */
export function ReputationBar({
  value,
  className,
}: {
  value: number | null | undefined;
  className?: string;
}): React.JSX.Element {
  const v =
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  const tone = v >= 66 ? "bg-ok" : v >= 33 ? "bg-warn" : "bg-bad";
  return (
    <span
      className={cn("inline-flex items-center gap-2", className)}
      title={`reputation ${v.toFixed(1)} / 100`}
    >
      <span className="h-1.5 w-16 overflow-hidden rounded-sm bg-line">
        <span className={cn("block h-full", tone)} style={{ width: `${v}%` }} />
      </span>
      <span className="tnum font-mono text-xs text-ink">{v.toFixed(0)}</span>
    </span>
  );
}
