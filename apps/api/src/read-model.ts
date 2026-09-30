import { agents, experiments, jobs, payments, worldEvents, type Database } from "@aigentia/db";
import {
  InMemoryWorldStore,
  type JobRecord,
  type PaymentRecord,
  type WorldStore,
} from "@aigentia/game-engine";
import { worldEventSchema, type WorldEvent } from "@aigentia/protocol";
import { AigentiaError, type JobStatus } from "@aigentia/shared";
import { and, asc, count, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";

export type ExperimentRecord = typeof experiments.$inferSelect;

/** Keyset cursor for the transactions feed: newest first, strictly older than the cursor. */
export interface PaymentsCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface PaymentsQuery {
  readonly limit: number;
  readonly cursor?: PaymentsCursor;
}

export interface PaymentTotals {
  /** Payments with a validated ledger transaction. */
  readonly validated: number;
  /** Validated x402 service purchases. */
  readonly servicePurchases: number;
  /** Sum of validated XRP amounts (drops). */
  readonly volumeDrops: bigint;
}

/** Jobs that still occupy an agent: open, claimed or submitted. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["open", "claimed", "submitted"];

/**
 * Spectator queries that cut across the engine's per-agent store methods (global payment
 * feed, totals, event pages, experiments). Implemented over any WorldStore for tests and
 * single-process demos, and directly over drizzle for the Postgres deployment.
 */
export interface ReadModel {
  listPayments(query: PaymentsQuery): Promise<PaymentRecord[]>;
  paymentTotals(): Promise<PaymentTotals>;
  listJobs(status?: JobStatus): Promise<JobRecord[]>;
  countActiveJobs(): Promise<number>;
  /**
   * Ascending by id, at most `limit`: the events with id > `after`, or the most recent
   * `limit` events when `after` is null (the dashboard's initial load).
   */
  eventsAfter(after: number | null, limit: number): Promise<WorldEvent[]>;
  listExperiments(): Promise<ExperimentRecord[]>;
  getExperiment(id: string): Promise<ExperimentRecord | null>;
  countAgentsByExperiment(): Promise<Map<string, number>>;
}

export function encodePaymentsCursor(p: Pick<PaymentRecord, "createdAt" | "id">): string {
  return `${p.createdAt.toISOString()}|${p.id}`;
}

/** Throws VALIDATION_FAILED for anything that is not `<iso date>|<payment id>`. */
export function decodePaymentsCursor(raw: string): PaymentsCursor {
  const sep = raw.lastIndexOf("|");
  const iso = sep === -1 ? "" : raw.slice(0, sep);
  const id = sep === -1 ? "" : raw.slice(sep + 1);
  const createdAt = new Date(iso);
  if (!iso || !id || Number.isNaN(createdAt.getTime())) {
    throw new AigentiaError("VALIDATION_FAILED", "malformed cursor", { cursor: raw });
  }
  return { createdAt, id };
}

/** Newest first: createdAt desc, then id desc (ties are deterministic). */
export function comparePaymentsDesc(
  a: Pick<PaymentRecord, "createdAt" | "id">,
  b: Pick<PaymentRecord, "createdAt" | "id">,
): number {
  const dt = b.createdAt.getTime() - a.createdAt.getTime();
  if (dt !== 0) return dt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function isOlderThan(p: Pick<PaymentRecord, "createdAt" | "id">, c: PaymentsCursor): boolean {
  const dt = p.createdAt.getTime() - c.createdAt.getTime();
  return dt < 0 || (dt === 0 && p.id < c.id);
}

function isActiveJob(j: JobRecord): boolean {
  return ACTIVE_JOB_STATUSES.includes(j.status);
}

/** How many events the generic store scan looks back when the store keeps no event index. */
export const EVENT_SCAN_LIMIT = 2000;
const PER_AGENT_SCAN_LIMIT = 100_000;

/**
 * Derives the global views from the WorldStore contract alone (payments and jobs are
 * reachable per agent; funding payments carry the receiver). Experiments are not part
 * of the engine store, so this model lists none.
 */
export class WorldStoreReadModel implements ReadModel {
  constructor(private readonly store: WorldStore) {}

  private async allPayments(): Promise<PaymentRecord[]> {
    const byId = new Map<string, PaymentRecord>();
    for (const agent of await this.store.listAgents()) {
      for (const p of await this.store.listPaymentsForAgent(agent.id, PER_AGENT_SCAN_LIMIT)) {
        byId.set(p.id, p);
      }
    }
    return [...byId.values()].sort(comparePaymentsDesc);
  }

  private async allJobs(): Promise<JobRecord[]> {
    const byId = new Map<string, JobRecord>();
    for (const j of await this.store.listOpenJobs()) byId.set(j.id, j);
    for (const agent of await this.store.listAgents()) {
      for (const j of await this.store.listAgentJobs(agent.id)) byId.set(j.id, j);
    }
    return [...byId.values()].sort((a, b) => comparePaymentsDesc(a, b));
  }

  async listPayments(query: PaymentsQuery): Promise<PaymentRecord[]> {
    const all = await this.allPayments();
    const cursor = query.cursor;
    const page = cursor ? all.filter((p) => isOlderThan(p, cursor)) : all;
    return page.slice(0, query.limit);
  }

  async paymentTotals(): Promise<PaymentTotals> {
    let validated = 0;
    let servicePurchases = 0;
    let volumeDrops = 0n;
    for (const p of await this.allPayments()) {
      if (p.status !== "validated") continue;
      validated += 1;
      if (p.kind === "x402") servicePurchases += 1;
      if (p.asset === "XRP") volumeDrops += p.amountDrops;
    }
    return { validated, servicePurchases, volumeDrops };
  }

  async listJobs(status?: JobStatus): Promise<JobRecord[]> {
    const all = await this.allJobs();
    return status === undefined ? all : all.filter((j) => j.status === status);
  }

  async countActiveJobs(): Promise<number> {
    return (await this.allJobs()).filter(isActiveJob).length;
  }

  async eventsAfter(after: number | null, limit: number): Promise<WorldEvent[]> {
    if (after === null) return this.store.recentEvents(limit);
    const source =
      this.store instanceof InMemoryWorldStore
        ? this.store.allEvents()
        : await this.store.recentEvents(EVENT_SCAN_LIMIT);
    return source
      .filter((e) => e.id !== undefined && e.id > after)
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
      .slice(0, limit);
  }

  async listExperiments(): Promise<ExperimentRecord[]> {
    return [];
  }

  async getExperiment(): Promise<ExperimentRecord | null> {
    return null;
  }

  async countAgentsByExperiment(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const a of await this.store.listAgents()) {
      if (a.experimentId) counts.set(a.experimentId, (counts.get(a.experimentId) ?? 0) + 1);
    }
    return counts;
  }
}

function toWorldEvent(row: typeof worldEvents.$inferSelect): WorldEvent {
  return worldEventSchema.parse({
    id: row.id,
    tick: row.tick,
    type: row.type,
    message: row.message,
    agentId: row.agentId,
    counterpartyId: row.counterpartyId,
    experimentId: row.experimentId,
    txHash: row.txHash,
    amountDrops: row.amountDrops === null ? null : row.amountDrops.toString(),
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Indexed queries over the real tables (apps/api in production). */
export class PostgresReadModel implements ReadModel {
  constructor(private readonly db: Database) {}

  async listPayments(query: PaymentsQuery): Promise<PaymentRecord[]> {
    const c = query.cursor;
    return this.db
      .select()
      .from(payments)
      .where(
        c
          ? or(
              lt(payments.createdAt, c.createdAt),
              and(eq(payments.createdAt, c.createdAt), lt(payments.id, c.id)),
            )
          : undefined,
      )
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(query.limit);
  }

  async paymentTotals(): Promise<PaymentTotals> {
    const rows = await this.db
      .select({
        validated: count(),
        servicePurchases: sql<string | number>`count(*) filter (where ${payments.kind} = 'x402')`,
        volume: sql<
          string | number | bigint | null
        >`coalesce(sum(${payments.amountDrops}) filter (where ${payments.asset} = 'XRP'), 0)`,
      })
      .from(payments)
      .where(eq(payments.status, "validated"));
    const row = rows[0];
    return {
      validated: Number(row?.validated ?? 0),
      servicePurchases: Number(row?.servicePurchases ?? 0),
      volumeDrops:
        row?.volume === null || row?.volume === undefined ? 0n : BigInt(String(row.volume)),
    };
  }

  async listJobs(status?: JobStatus): Promise<JobRecord[]> {
    return this.db
      .select()
      .from(jobs)
      .where(status === undefined ? undefined : eq(jobs.status, status))
      .orderBy(desc(jobs.createdAt), desc(jobs.id));
  }

  async countActiveJobs(): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(jobs)
      .where(inArray(jobs.status, [...ACTIVE_JOB_STATUSES]));
    return Number(rows[0]?.n ?? 0);
  }

  async eventsAfter(after: number | null, limit: number): Promise<WorldEvent[]> {
    if (after === null) {
      const latest = await this.db
        .select()
        .from(worldEvents)
        .orderBy(desc(worldEvents.id))
        .limit(limit);
      return latest.reverse().map(toWorldEvent);
    }
    const rows = await this.db
      .select()
      .from(worldEvents)
      .where(gt(worldEvents.id, after))
      .orderBy(asc(worldEvents.id))
      .limit(limit);
    return rows.map(toWorldEvent);
  }

  async listExperiments(): Promise<ExperimentRecord[]> {
    return this.db.select().from(experiments).orderBy(desc(experiments.createdAt));
  }

  async getExperiment(id: string): Promise<ExperimentRecord | null> {
    const rows = await this.db.select().from(experiments).where(eq(experiments.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async countAgentsByExperiment(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ experimentId: agents.experimentId, n: count() })
      .from(agents)
      .groupBy(agents.experimentId);
    const counts = new Map<string, number>();
    for (const r of rows) if (r.experimentId) counts.set(r.experimentId, Number(r.n));
    return counts;
  }
}
