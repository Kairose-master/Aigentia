import { AigentiaError } from "@aigentia/shared";
import type { z } from "zod";

/** Validate a query/body against a zod schema; failures become 400 VALIDATION_FAILED. */
export function parseWith<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AigentiaError("VALIDATION_FAILED", `invalid ${what}`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}
