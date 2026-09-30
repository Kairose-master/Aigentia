import { cn } from "@/lib/utils";
import { formatXrp, formatXrpCompact } from "@/lib/format";
import type { Tone } from "@/lib/colors";
import { TONE_TEXT } from "@/lib/colors";

/** Monospace, tabular XRP amount from a drops string. */
export function Money({
  drops,
  compact = false,
  maxFraction,
  signed = false,
  unit = true,
  tone,
  className,
}: {
  drops: string | bigint | number | null | undefined;
  compact?: boolean;
  maxFraction?: number;
  signed?: boolean;
  unit?: boolean;
  tone?: Tone;
  className?: string;
}): React.JSX.Element {
  const text = compact ? formatXrpCompact(drops) : formatXrp(drops, { maxFraction, signed });
  return (
    <span
      className={cn(
        "tnum font-mono whitespace-nowrap",
        tone ? TONE_TEXT[tone] : "text-ink-strong",
        className,
      )}
      title={formatXrp(drops, { unit: true })}
    >
      {text}
      {unit && text !== "—" && <span className="ml-1 text-[10px] text-ink-muted">XRP</span>}
    </span>
  );
}
