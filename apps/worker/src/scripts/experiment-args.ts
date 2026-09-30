import { GENESIS_24H } from "@aigentia/game-engine";
import type { ExperimentConfigInput } from "@aigentia/protocol";

/**
 * Pure: build an experiment config from CLI flags. Starts from Genesis 24H and scales it:
 *   --agents N (multiple of 4, split evenly over the four objectives) --hours H --capital XRP
 *   --name "..." --seed s --brain deterministic|llm
 */
export function parseExperimentArgs(argv: readonly string[]): ExperimentConfigInput {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    if (!key) continue;
    const value = inline ?? argv[i + 1];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    if (inline === undefined) i += 1;
    flags.set(key, value);
  }
  const num = (key: string, fallback: number): number => {
    const raw = flags.get(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} expects a positive number`);
    return n;
  };
  const agents = num("agents", GENESIS_24H.agentCount);
  if (!Number.isInteger(agents) || agents % 4 !== 0) {
    throw new Error("--agents must be a multiple of 4 (one quarter per objective)");
  }
  const brain = flags.get("brain") ?? "deterministic";
  if (brain !== "deterministic" && brain !== "llm")
    throw new Error("--brain is deterministic or llm");
  const quarter = agents / 4;
  return {
    ...GENESIS_24H,
    name:
      flags.get("name") ??
      (agents === 20 ? GENESIS_24H.name : `Genesis ${agents}x${num("hours", 24)}h`),
    durationHours: num("hours", GENESIS_24H.durationHours),
    agentCount: agents,
    startingCapitalXrp: num("capital", GENESIS_24H.startingCapitalXrp),
    seed: flags.get("seed") ?? GENESIS_24H.seed,
    brain,
    objectiveDistribution: GENESIS_24H.objectiveDistribution.map((o) => ({ ...o, count: quarter })),
  };
}
