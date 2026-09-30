export const nowIso = (): string => new Date().toISOString();

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** XRPL "Ripple epoch" starts 2000-01-01T00:00:00Z. */
export const RIPPLE_EPOCH_OFFSET_SECONDS = 946_684_800;

export function rippleTimeToDate(rippleSeconds: number): Date {
  return new Date((rippleSeconds + RIPPLE_EPOCH_OFFSET_SECONDS) * 1000);
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
