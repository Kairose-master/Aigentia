/**
 * Semantic colour mapping. Status colours are reserved signals (live / pending / settled /
 * failed); objectives use a validated categorical palette in fixed order.
 */
export type Tone = "live" | "warn" | "ok" | "bad" | "muted" | "violet";

export const TONE_TEXT: Record<Tone, string> = {
  live: "text-live",
  warn: "text-warn",
  ok: "text-ok",
  bad: "text-bad",
  muted: "text-ink-muted",
  violet: "text-violet",
};

export const TONE_DOT: Record<Tone, string> = {
  live: "bg-live",
  warn: "bg-warn",
  ok: "bg-ok",
  bad: "bg-bad",
  muted: "bg-ink-muted",
  violet: "bg-violet",
};

export const TONE_CHIP: Record<Tone, string> = {
  live: "border-live/40 bg-live/10 text-live",
  warn: "border-warn/40 bg-warn/10 text-warn",
  ok: "border-ok/40 bg-ok/10 text-ok",
  bad: "border-bad/40 bg-bad/10 text-bad",
  muted: "border-line-strong bg-panel-raised text-ink-muted",
  violet: "border-violet/40 bg-violet/10 text-violet",
};

/** Colour a WorldEvent type by what it means for the economy. */
export function eventTone(type: string): Tone {
  switch (type) {
    case "PAYMENT_VALIDATED":
    case "SERVICE_FULFILLED":
    case "JOB_COMPLETED":
    case "BOUNTY_PAID":
    case "RESOURCE_SOLD":
    case "TRANSFER_SENT":
      return "ok";
    case "PAYMENT_FAILED":
    case "PAYMENT_DENIED":
    case "SERVICE_FAILED":
    case "JOB_FAILED":
    case "AGENT_BANKRUPT":
    case "ACTION_INVALID":
    case "ACTION_REJECTED":
      return "bad";
    case "PAYMENT_SUBMITTED":
    case "SERVICE_QUOTED":
    case "JOB_POSTED":
    case "JOB_CLAIMED":
    case "JOB_SUBMITTED":
    case "BOUNTY_POSTED":
    case "RESOURCE_BOUGHT":
      return "warn";
    case "SERVICE_PURCHASED":
    case "SERVICE_LISTED":
    case "AGENT_CREATED":
    case "EXPERIMENT_STARTED":
    case "EXPERIMENT_FINISHED":
      return "live";
    case "DECISION_MADE":
    case "REPUTATION_CHANGED":
    case "AGENT_STATUS_CHANGED":
      return "violet";
    default:
      return "muted";
  }
}

/** Colour a status string (payments, jobs, agents, invocations, experiments, decisions). */
export function statusTone(status: string | null | undefined): Tone {
  switch ((status ?? "").toLowerCase()) {
    case "validated":
    case "completed":
    case "fulfilled":
    case "paid":
    case "success":
    case "finished":
      return "ok";
    case "failed":
    case "denied":
    case "rejected":
    case "invalid":
    case "bankrupt":
    case "aborted":
    case "cancelled":
      return "bad";
    case "intent":
    case "submitted":
    case "quoted":
    case "claimed":
    case "pending":
    case "paused":
    case "expired":
    case "draft":
      return "warn";
    case "active":
    case "running":
    case "open":
    case "live":
      return "live";
    default:
      return "muted";
  }
}

export const OBJECTIVE_ORDER = [
  "maximize_net_worth",
  "survive",
  "maximize_information",
  "maximize_reputation",
  "build_coalition",
  "information_broker",
  "profitable_service",
] as const;

/** Validated categorical palette (dark surface #0b0f14), in fixed objective order. */
export const OBJECTIVE_COLORS: Record<string, string> = {
  maximize_net_worth: "#0891b2",
  survive: "#db2777",
  maximize_information: "#65a30d",
  maximize_reputation: "#8b5cf6",
  build_coalition: "#ea580c",
  information_broker: "#0d9488",
  profitable_service: "#3b82f6",
};

export const OTHER_COLOR = "#64748b";

export function objectiveColor(objective: string | null | undefined): string {
  if (!objective) return OTHER_COLOR;
  return OBJECTIVE_COLORS[objective] ?? OTHER_COLOR;
}

/** Resource deposit ring colours (Genesis Sector resources). */
export const RESOURCE_COLORS: Record<string, string> = {
  ore: "#ea580c",
  data: "#0891b2",
  energy: "#f59e0b",
  alloy: "#8b5cf6",
};

export function resourceColor(resourceType: string): string {
  return RESOURCE_COLORS[resourceType] ?? OTHER_COLOR;
}
