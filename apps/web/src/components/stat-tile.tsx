import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/colors";
import { TONE_DOT } from "@/lib/colors";

export function StatTile({
  label,
  value,
  unit,
  hint,
  tone = "muted",
  className,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  hint?: React.ReactNode;
  tone?: Tone;
  className?: string;
  testId?: string;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className={cn(
        "relative flex min-w-0 flex-col gap-1 border-line bg-panel px-3 py-2.5",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-0 left-0 h-full w-px",
          tone === "muted" ? "bg-line-strong" : TONE_DOT[tone],
        )}
        aria-hidden
      />
      <span className="eyebrow truncate">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="tnum font-mono text-xl leading-none font-semibold text-ink-strong">
          {value}
        </span>
        {unit && (
          <span className="font-mono text-[10px] tracking-[0.14em] text-ink-muted uppercase">
            {unit}
          </span>
        )}
      </span>
      {hint && <span className="text-[11px] text-ink-muted">{hint}</span>}
    </div>
  );
}
