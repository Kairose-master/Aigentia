import { parseDrops } from "@aigentia/shared";
import type { AgentAction } from "@aigentia/protocol";
import { courierInputSchema } from "@aigentia/protocol";
import type { BalanceSnapshot } from "@aigentia/xrpl";
import { serviceInputError } from "./services";
import type { AgentRecord, WorldStore } from "./store/types";

export interface ValidationContext {
  readonly tick: number;
  /** Live balance of the acting agent (from the observation step). */
  readonly balance: BalanceSnapshot;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const ok: ValidationResult = { ok: true };
const reject = (reason: string): ValidationResult => ({ ok: false, reason });

function heldQuantity(
  inventory: readonly { resourceType: string; quantity: number }[],
  resourceType: string,
): number {
  return inventory
    .filter((i) => i.resourceType === resourceType)
    .reduce((sum, i) => sum + i.quantity, 0);
}

/**
 * Semantic checks a schema cannot express: referenced things exist and are not the agent
 * itself, price ceilings hold, ownership is right and the agent can afford what it commits
 * to. Economic safety proper (caps, reserve) is the PolicyEngine's job at settlement time;
 * this is the cheap pre-check that keeps obviously doomed actions out of the ledger path.
 */
export async function validateAction(
  agent: AgentRecord,
  action: AgentAction,
  store: WorldStore,
  ctx: ValidationContext,
): Promise<ValidationResult> {
  const minimumBalance = parseDrops(agent.budgetPolicy.minimumBalanceDrops);
  const headroom = ctx.balance.spendableDrops - minimumBalance;

  switch (action.type) {
    case "WAIT":
      return ok;

    case "BUY_SERVICE": {
      const service = await store.getService(action.serviceId);
      if (!service) return reject(`service ${action.serviceId} does not exist`);
      if (service.status !== "active")
        return reject(`service ${service.name} is ${service.status}`);
      if (service.sellerAgentId === agent.id) return reject("cannot buy your own service");
      const seller = await store.getAgent(service.sellerAgentId);
      if (!seller || !seller.walletAddress) return reject("seller has no wallet");
      if (seller.status !== "active") return reject(`seller ${seller.name} is ${seller.status}`);
      const maxPrice = parseDrops(action.maxPriceDrops);
      if (service.priceDrops > maxPrice) {
        return reject(
          `service price ${service.priceDrops} drops exceeds the ceiling of ${maxPrice} drops`,
        );
      }
      const inputError = serviceInputError(service.kind, action.input);
      if (inputError) return reject(`invalid ${service.kind} input: ${inputError}`);
      if (service.kind === "COURIER") {
        const params = courierInputSchema.parse(action.input);
        const inventory = await store.getInventory(agent.id);
        const at =
          inventory.find(
            (i) => i.resourceType === params.resourceType && i.locationId === params.fromLocationId,
          )?.quantity ?? 0;
        if (at < params.quantity) {
          return reject(
            `only ${at} ${params.resourceType} held at ${params.fromLocationId}, need ${params.quantity}`,
          );
        }
      }
      return ok;
    }

    case "SELL_SERVICE":
      return parseDrops(action.priceDrops) > 0n ? ok : reject("price must be positive");

    case "POST_JOB": {
      const reward = parseDrops(action.rewardDrops);
      if (reward > headroom) {
        return reject(
          `reward ${reward} drops exceeds spendable balance minus minimum balance (${headroom < 0n ? 0n : headroom} drops)`,
        );
      }
      const req = action.requirement;
      if (req && req.kind === "deliver_resource" && req.resourceType === undefined) {
        return reject("deliver_resource jobs must name a resourceType");
      }
      return ok;
    }

    case "ACCEPT_JOB": {
      const job = await store.getJob(action.jobId);
      if (!job) return reject(`job ${action.jobId} does not exist`);
      if (job.posterAgentId === agent.id) return reject("cannot accept your own job");
      if (job.status !== "open") return reject(`job "${job.title}" is ${job.status}`);
      if (job.expiresAtTick <= ctx.tick) return reject(`job "${job.title}" has expired`);
      return ok;
    }

    case "SUBMIT_JOB": {
      const job = await store.getJob(action.jobId);
      if (!job) return reject(`job ${action.jobId} does not exist`);
      if (job.claimedByAgentId !== agent.id) return reject("only the claimer can submit this job");
      if (job.status !== "claimed") return reject(`job "${job.title}" is ${job.status}`);
      return ok;
    }

    case "TRANSFER": {
      const amount = parseDrops(action.amountDrops);
      if (amount <= 0n) return reject("transfer amount must be positive");
      if (action.toAgentId === agent.id) return reject("cannot transfer to yourself");
      const to = await store.getAgent(action.toAgentId);
      if (!to) return reject(`agent ${action.toAgentId} does not exist`);
      if (!to.walletAddress) return reject(`${to.name} has no wallet`);
      if (to.walletAddress === agent.walletAddress) return reject("cannot transfer to yourself");
      return ok;
    }

    case "BUY_RESOURCE": {
      const maxUnit = parseDrops(action.maxUnitPriceDrops);
      if (action.listingId !== undefined) {
        const listing = await store.getListing(action.listingId);
        if (!listing) return reject(`listing ${action.listingId} does not exist`);
        if (listing.status !== "open") return reject("listing is no longer open");
        if (listing.sellerAgentId === agent.id) return reject("cannot buy your own listing");
        if (listing.quantity < action.quantity) {
          return reject(`listing only has ${listing.quantity} ${listing.resourceType}`);
        }
        if (listing.resourceType !== action.resourceType) {
          return reject(`listing sells ${listing.resourceType}, not ${action.resourceType}`);
        }
        if (listing.unitPriceDrops > maxUnit) {
          return reject(`listing price ${listing.unitPriceDrops} drops exceeds ${maxUnit} drops`);
        }
        const seller = await store.getAgent(listing.sellerAgentId);
        if (!seller || !seller.walletAddress) return reject("listing seller has no wallet");
        return ok;
      }
      const prices = await store.getMarketPrices();
      const price = prices.find((p) => p.resourceType === action.resourceType);
      if (!price) return reject(`no market for ${action.resourceType}`);
      if (price.supply < action.quantity) {
        return reject(`market only holds ${price.supply} ${action.resourceType}`);
      }
      if (price.askDrops > maxUnit) {
        return reject(`market ask ${price.askDrops} drops exceeds ${maxUnit} drops`);
      }
      return ok;
    }

    case "SELL_RESOURCE": {
      const inventory = await store.getInventory(agent.id);
      const held = heldQuantity(inventory, action.resourceType);
      if (held < action.quantity) {
        return reject(`only ${held} ${action.resourceType} in inventory, need ${action.quantity}`);
      }
      if (action.toMarket) {
        const prices = await store.getMarketPrices();
        const price = prices.find((p) => p.resourceType === action.resourceType);
        if (!price) return reject(`no market for ${action.resourceType}`);
        if (price.bidDrops <= 0n) return reject(`market bid for ${action.resourceType} is zero`);
      }
      return ok;
    }

    default: {
      const exhaustive: never = action;
      return reject(`unknown action ${JSON.stringify(exhaustive)}`);
    }
  }
}
