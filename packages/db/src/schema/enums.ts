import { pgEnum } from "drizzle-orm/pg-core";
import {
  AGENT_STATUSES,
  BOUNTY_STATUSES,
  BRAIN_KINDS,
  EXPERIMENT_STATUSES,
  INVOCATION_STATUSES,
  JOB_STATUSES,
  OBJECTIVES,
  PAYMENT_KINDS,
  PAYMENT_STATUSES,
  RESOURCE_TYPES,
  SERVICE_KINDS,
} from "@aigentia/shared";

export const objectiveEnum = pgEnum("objective", OBJECTIVES);
export const agentStatusEnum = pgEnum("agent_status", AGENT_STATUSES);
export const serviceKindEnum = pgEnum("service_kind", SERVICE_KINDS);
export const resourceTypeEnum = pgEnum("resource_type", RESOURCE_TYPES);
export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);
export const bountyStatusEnum = pgEnum("bounty_status", BOUNTY_STATUSES);
export const paymentKindEnum = pgEnum("payment_kind", PAYMENT_KINDS);
export const paymentStatusEnum = pgEnum("payment_status", PAYMENT_STATUSES);
export const invocationStatusEnum = pgEnum("invocation_status", INVOCATION_STATUSES);
export const experimentStatusEnum = pgEnum("experiment_status", EXPERIMENT_STATUSES);
export const brainKindEnum = pgEnum("brain_kind", BRAIN_KINDS);
export const ledgerKindEnum = pgEnum("ledger_kind", ["testnet", "mock"]);
export const serviceStatusEnum = pgEnum("service_status", ["active", "paused", "retired"]);
export const listingStatusEnum = pgEnum("listing_status", ["open", "filled", "cancelled"]);
export const decisionOutcomeEnum = pgEnum("decision_outcome", [
  "pending",
  "success",
  "failed",
  "rejected",
  "invalid",
]);
