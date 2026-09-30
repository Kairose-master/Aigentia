export interface DemoArgs {
  readonly ticks: number;
}

export const DEFAULT_DEMO_TICKS = 5;

/** Pure: `--ticks 5` or `--ticks=5`; anything else keeps the default. Throws on a bad count. */
export function parseDemoArgs(
  argv: readonly string[],
  defaults: DemoArgs = { ticks: DEFAULT_DEMO_TICKS },
): DemoArgs {
  let ticks = defaults.ticks;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    let raw: string | undefined;
    if (arg === "--ticks") raw = argv[i + 1];
    else if (arg.startsWith("--ticks=")) raw = arg.slice("--ticks=".length);
    else continue;
    const n = Number(raw);
    if (raw === undefined || !Number.isInteger(n) || n < 0 || n > 10_000) {
      throw new Error(`--ticks expects an integer between 0 and 10000, got ${raw ?? "nothing"}`);
    }
    ticks = n;
  }
  return { ticks };
}
