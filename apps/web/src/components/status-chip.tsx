import { cn } from "@/lib/utils";
import { TONE_CHIP, statusTone, type Tone } from "@/lib/colors";

export function StatusChip({
  status,
  tone,
  className,
}: {
  status: string | null | undefined;
  tone?: Tone;
  className?: string;
}): React.JSX.Element {
  const label = status && status.length > 0 ? status : "unknown";
  const t = tone ?? statusTone(status);
  return (
    <span
      data-status={label}
      className={cn(
        "inline-flex h-5 items-center rounded-sm border px-1.5 font-mono text-[10px] tracking-[0.14em] uppercase",
        TONE_CHIP[t],
        className,
      )}
    >
      {label}
    </span>
  );
}
