import type { DecisionTraceDto } from "@aigentia/protocol";
import { cn } from "@/lib/utils";
import { TONE_TEXT, statusTone } from "@/lib/colors";
import { formatLatency, timeAgo } from "@/lib/format";
import { Money } from "@/components/money";
import { StatusChip } from "@/components/status-chip";
import { TxLink } from "@/components/address-link";
import { MockBadge } from "@/components/ledger-badge";

function actionType(action: Record<string, unknown>): string {
  const t = action.type;
  return typeof t === "string" ? t : "UNKNOWN";
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-3 border-t border-line/60 py-1.5 first:border-0">
      <span className="eyebrow pt-0.5">{label}</span>
      <div className="min-w-0 text-sm text-ink">{children}</div>
    </div>
  );
}

/**
 * The canonical decision trace: Observation → Decision → Reason → Cost → Transaction → Outcome.
 * This is the shape the whole product promises for explainability.
 */
export function DecisionTraceCard({
  trace,
  now,
}: {
  trace: DecisionTraceDto;
  now?: Date;
}): React.JSX.Element {
  const tone = statusTone(trace.outcomeStatus);
  const type = actionType(trace.action);
  return (
    <article
      data-testid="decision-trace"
      className={cn(
        "rounded-md border border-line bg-panel px-3 py-2",
        tone === "bad" && "border-bad/30",
      )}
    >
      <header className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] tracking-[0.14em] text-ink-muted uppercase">
          tick {trace.tick}
        </span>
        <span className="rounded-sm border border-live/30 bg-live/10 px-1.5 font-mono text-[10px] tracking-[0.14em] text-live uppercase">
          {type}
        </span>
        <StatusChip status={trace.outcomeStatus} />
        <span className="ml-auto font-mono text-[10px] text-ink-dim">
          {trace.brain}
          {trace.latencyMs !== null ? ` · ${formatLatency(trace.latencyMs)}` : ""} ·{" "}
          {timeAgo(trace.createdAt, now)}
        </span>
      </header>
      <Row label="Observation">
        {trace.observationSummary || <span className="text-ink-dim">—</span>}
      </Row>
      <Row label="Decision">{trace.summary || type}</Row>
      <Row label="Reason">{trace.reason || <span className="text-ink-dim">—</span>}</Row>
      <Row label="Cost">
        {trace.costDrops ? (
          <Money drops={trace.costDrops} tone="warn" />
        ) : (
          <span className="text-ink-dim">no cost</span>
        )}
      </Row>
      <Row label="Transaction">
        {trace.txHash ? (
          trace.explorerUrl ? (
            <TxLink txHash={trace.txHash} explorerUrl={trace.explorerUrl} />
          ) : (
            <span className="inline-flex items-center gap-1.5 font-mono text-xs">
              <TxLink txHash={trace.txHash} ledger="mock" />
            </span>
          )
        ) : (
          <span className="inline-flex items-center gap-2 text-ink-dim">
            none{" "}
            {trace.explorerUrl === null && trace.costDrops && trace.costDrops !== "0" ? (
              <MockBadge />
            ) : null}
          </span>
        )}
      </Row>
      <Row label="Outcome">
        <span className={cn(TONE_TEXT[tone])}>{trace.outcome ?? trace.outcomeStatus}</span>
      </Row>
    </article>
  );
}
