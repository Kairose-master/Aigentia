import { cn } from "@/lib/utils";

export function Panel({
  title,
  eyebrow,
  action,
  className,
  bodyClassName,
  children,
}: {
  title?: React.ReactNode;
  eyebrow?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className={cn("flex min-w-0 flex-col rounded-md border border-line bg-panel", className)}
    >
      {(title || eyebrow || action) && (
        <header className="flex items-center gap-3 border-b border-line px-3 py-2">
          <div className="min-w-0">
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            {title && (
              <h2 className="truncate font-mono text-xs font-medium tracking-[0.08em] text-ink-strong uppercase">
                {title}
              </h2>
            )}
          </div>
          {action && <div className="ml-auto shrink-0">{action}</div>}
        </header>
      )}
      <div className={cn("min-w-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div>
        <h1 className="font-mono text-lg font-semibold tracking-[0.2em] text-ink-strong uppercase">
          {title}
        </h1>
        {subtitle && <p className="mt-1 max-w-3xl text-xs text-ink-muted">{subtitle}</p>}
      </div>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  offline,
  className,
}: {
  title: string;
  detail?: string;
  offline?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      data-testid={offline ? "offline-state" : "empty-state"}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center",
        className,
      )}
    >
      <span
        className={cn(
          "font-mono text-[11px] tracking-[0.2em] uppercase",
          offline ? "text-warn" : "text-ink-muted",
        )}
      >
        {offline ? "API offline" : "No data"}
      </span>
      <p className="text-sm text-ink">{title}</p>
      {detail && <p className="max-w-md text-xs text-ink-muted">{detail}</p>}
    </div>
  );
}

/** Banner shown at the top of a page when the API could not be reached. */
export function OfflineBanner({ message }: { message?: string }): React.JSX.Element {
  return (
    <div
      role="status"
      className="mb-4 flex items-center gap-3 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn"
    >
      <span className="size-1.5 rounded-full bg-warn" />
      <span className="font-mono tracking-[0.14em] uppercase">Offline</span>
      <span className="text-ink-muted">
        {message ?? "The Aigentia API is unreachable. Showing an empty world until it comes back."}
      </span>
    </div>
  );
}
