import { SERVICE_SCHEMAS } from "@aigentia/protocol";
import type { AnalystOutput, CourierOutput, ScoutOutput } from "@aigentia/protocol";
import { AigentiaError, type ServiceKind } from "@aigentia/shared";
import { executeAnalyst } from "./analyst";
import { executeCourier } from "./courier";
import { executeScout } from "./scout";
import type { ServiceContext } from "./types";

export type ServiceOutput = ScoutOutput | AnalystOutput | CourierOutput;

/** Signature of a service runner; the purchaser takes one so tests can inject faults. */
export type ServiceExecutor = (
  kind: ServiceKind,
  input: unknown,
  ctx: ServiceContext,
) => Promise<ServiceOutput>;

/**
 * Run one of the three seed services against the world and return its output, validated
 * against the protocol output schema. Input is validated by the service itself
 * (VALIDATION_FAILED via Zod); any throw is a service failure for the caller to record.
 */
export async function executeService(
  kind: ServiceKind,
  input: unknown,
  ctx: ServiceContext,
): Promise<ServiceOutput> {
  switch (kind) {
    case "SCOUT":
      return executeScout(input, ctx);
    case "ANALYST":
      return executeAnalyst(input, ctx);
    case "COURIER":
      return executeCourier(input, ctx);
    default: {
      const exhaustive: never = kind;
      throw new AigentiaError("VALIDATION_FAILED", `unknown service kind ${String(exhaustive)}`);
    }
  }
}

/** Validate a service input without running it; returns the parse error message or null. */
export function serviceInputError(kind: ServiceKind, input: unknown): string | null {
  const parsed = SERVICE_SCHEMAS[kind].input.safeParse(input);
  if (parsed.success) return null;
  return parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
    .join("; ");
}

/** Validate a service output against the protocol schema (the buyer-side check). */
export function validateServiceOutput(kind: ServiceKind, output: unknown): ServiceOutput {
  const parsed = SERVICE_SCHEMAS[kind].output.safeParse(output);
  if (!parsed.success) {
    throw new AigentiaError("VALIDATION_FAILED", `${kind} output failed schema validation`, {
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  return parsed.data;
}

export { executeScout, executeAnalyst, executeCourier };
export { analyseMarket } from "./analyst";
export type { MarketAnalysis } from "./analyst";
export type { ServiceContext } from "./types";
