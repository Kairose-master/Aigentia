import {
  x402PaymentRequiredSchema,
  type X402Network,
  type X402PaymentRequired,
  type X402PaymentRequirements,
} from "@aigentia/protocol";
import { AigentiaError, isDropsString } from "@aigentia/shared";

/**
 * What the buyer already knows and trusts before it sees a 402: our own marketplace record
 * of the service and the buyer's policy. Every field of a remote 402 is checked against this.
 */
export interface RequirementExpectation {
  /** CAIP-2 network the buyer is configured for, e.g. "xrpl:1". */
  readonly network: X402Network;
  /** Assets the buyer's budget policy allows ("XRP" today). */
  readonly allowedAssets: readonly string[];
  /** The price listed in the marketplace; a 402 asking for anything else is refused. */
  readonly listedPriceDrops: bigint;
  /** The buyer's hard ceiling for this call. */
  readonly maxPriceDrops: bigint;
  /** The seller's registered wallet address. */
  readonly payTo: string;
  /** SourceTag this deployment stamps on x402 payments; a different one is refused. */
  readonly sourceTag: number;
  /** Facilitator ids the buyer accepts in extra.facilitator (empty → none accepted). */
  readonly trustedFacilitators: readonly string[];
  /** Longest quote validity the buyer accepts. */
  readonly maxTimeoutSeconds: number;
}

export type RequirementRejection =
  | "malformed_402"
  | "no_supported_requirement"
  | "network_mismatch"
  | "asset_not_allowed"
  | "invalid_amount"
  | "amount_mismatch"
  | "amount_exceeds_ceiling"
  | "destination_mismatch"
  | "missing_invoice"
  | "source_tag_mismatch"
  | "untrusted_facilitator"
  | "unexpected_destination_tag"
  | "timeout_too_long"
  | "cross_currency_not_supported";

function reject(reason: RequirementRejection, details: Record<string, unknown> = {}): never {
  throw new AigentiaError(
    reason === "malformed_402" ? "X402_MALFORMED" : "X402_UNTRUSTED",
    `refusing x402 payment requirements: ${reason}`,
    { reason, ...details },
  );
}

/** Parse an HTTP 402 body; X402_MALFORMED unless it is a well-formed x402 v2 PaymentRequired. */
export function parsePaymentRequired(body: unknown): X402PaymentRequired {
  const parsed = x402PaymentRequiredSchema.safeParse(body);
  if (!parsed.success) {
    reject("malformed_402", {
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  return parsed.data;
}

/**
 * handle402: treat the remote response as untrusted input and return the single payment
 * requirement the buyer may pay, or throw. Validates network, scheme, asset, amount (against
 * both the listed price and the buyer's ceiling), destination, invoice binding, facilitator,
 * source tag and quote lifetime. Nothing reaches a PaymentIntent unless all of them pass.
 */
export function validatePaymentRequirements(
  body: unknown,
  expect: RequirementExpectation,
): X402PaymentRequirements {
  const required = parsePaymentRequired(body);
  const candidates = required.accepts.filter(
    (r) => r.scheme === "exact" && r.network === expect.network,
  );
  if (candidates.length === 0) {
    const networks = required.accepts.map((r) => r.network);
    reject(networks.includes(expect.network) ? "no_supported_requirement" : "network_mismatch", {
      offered: required.accepts.map((r) => `${r.scheme}@${r.network}`),
    });
  }
  // Prefer an XRP requirement; the first acceptable one wins (server order), deterministically.
  const req = candidates.find((r) => r.asset === "XRP") ?? candidates[0];
  if (!req) reject("no_supported_requirement");

  if (!expect.allowedAssets.includes(req.asset)) reject("asset_not_allowed", { asset: req.asset });
  if (req.asset !== "XRP") reject("asset_not_allowed", { asset: req.asset });
  if (!isDropsString(req.amount) || BigInt(req.amount) <= 0n) {
    reject("invalid_amount", { amount: req.amount });
  }
  const amount = BigInt(req.amount);
  if (amount !== expect.listedPriceDrops) {
    reject("amount_mismatch", { amount: req.amount, listed: expect.listedPriceDrops.toString() });
  }
  if (amount > expect.maxPriceDrops) {
    reject("amount_exceeds_ceiling", {
      amount: req.amount,
      ceiling: expect.maxPriceDrops.toString(),
    });
  }
  if (req.payTo !== expect.payTo) {
    reject("destination_mismatch", { payTo: req.payTo, expected: expect.payTo });
  }
  const extra = req.extra ?? {};
  if (!extra.invoiceId) reject("missing_invoice");
  if (extra.sourceTag !== undefined && extra.sourceTag !== expect.sourceTag) {
    reject("source_tag_mismatch", { sourceTag: extra.sourceTag, expected: expect.sourceTag });
  }
  if (
    extra.facilitator !== undefined &&
    !expect.trustedFacilitators.includes(extra.facilitator.id)
  ) {
    reject("untrusted_facilitator", { facilitator: extra.facilitator.id });
  }
  if (extra.destinationTag !== undefined) {
    reject("unexpected_destination_tag", { destinationTag: extra.destinationTag });
  }
  if (extra.crossCurrency === true) reject("cross_currency_not_supported");
  if (req.maxTimeoutSeconds > expect.maxTimeoutSeconds) {
    reject("timeout_too_long", {
      maxTimeoutSeconds: req.maxTimeoutSeconds,
      limit: expect.maxTimeoutSeconds,
    });
  }
  return req;
}

/** Seller side: the 402 body for one quote. */
export function buildPaymentRequired(params: {
  readonly resourceUrl: string;
  readonly description: string;
  readonly network: X402Network;
  readonly payTo: string;
  readonly amountDrops: bigint;
  readonly invoiceId: string;
  readonly sourceTag: number;
  readonly maxTimeoutSeconds: number;
}): X402PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: params.resourceUrl,
      description: params.description,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: params.network,
        amount: params.amountDrops.toString(),
        asset: "XRP",
        payTo: params.payTo,
        maxTimeoutSeconds: params.maxTimeoutSeconds,
        extra: { invoiceId: params.invoiceId, sourceTag: params.sourceTag },
      },
    ],
    extensions: {},
  };
}
