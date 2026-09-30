import { cn } from "@/lib/utils";
import { objectiveColor } from "@/lib/colors";
import { humanize } from "@/lib/format";

export function ObjectiveBadge({
  objective,
  className,
}: {
  objective: string | null | undefined;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-ink", className)}>
      <span
        className="inline-block size-2 rounded-full"
        style={{ backgroundColor: objectiveColor(objective) }}
        aria-hidden
      />
      {humanize(objective)}
    </span>
  );
}
