import { z } from "zod";

/**
 * Every process validates its environment through this schema at startup.
 * Secrets are typed but never logged (see logger redaction). Values default to a
 * safe local-development configuration; production must set them explicitly.
 */
const bool = z
  .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0"), z.literal("")])
  .transform((v) => v === "true" || v === "1");

const drops = z.string().regex(/^\d+$/, "expected an integer number of drops");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.url().default("postgres://postgres:postgres@localhost:5432/aigentia"),
  REDIS_URL: z.url().default("redis://localhost:6379"),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_PUBLIC_URL: z.url().default("http://localhost:4000"),
  ADMIN_TOKEN: z.string().min(8).default("change-me-admin-token"),

  TICK_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  SIM_LEDGER: z.enum(["testnet", "mock"]).default("testnet"),
  SIM_SEED: z.string().min(1).default("genesis"),

  XRPL_NETWORK: z.enum(["testnet", "devnet"]).default("testnet"),
  XRPL_NETWORK_ID: z.coerce.number().int().default(1),
  XRPL_WSS_URL: z.url().default("wss://testnet.xrpl-labs.com/"),
  XRPL_RPC_URL: z.url().default("https://testnet.xrpl-labs.com/"),
  XRPL_FAUCET_URL: z.url().default("https://faucet.altnet.rippletest.net/accounts"),
  XRPL_EXPLORER_URL: z.url().default("https://testnet.xrpl.org"),
  XRPL_WALLET_PROVIDER: z.enum(["env", "file"]).default("file"),
  XRPL_WALLET_FILE: z.string().default(".aigentia/wallets.dev.json"),
  XRPL_WALLET_SEEDS: z.string().default(""),
  TREASURY_WALLET_REF: z.string().min(1).default("treasury"),

  X402_SERVICE_URL: z.url().default("http://localhost:8402"),
  X402_SERVICE_TOKEN: z.string().min(8).default("change-me-x402-internal-token"),
  X402_SOURCE_TAG: z.coerce.number().int().min(0).max(4294967295).default(804681468),
  X402_MAX_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),

  LLM_PROVIDER: z.enum(["none", "anthropic", "openai", "mock"]).default("none"),
  LLM_MODEL: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),

  POLICY_MAX_SPEND_PER_ACTION_DROPS: drops.default("500000"),
  POLICY_MAX_SPEND_PER_HOUR_DROPS: drops.default("3000000"),
  POLICY_MAX_DAILY_SPEND_DROPS: drops.default("8000000"),
  POLICY_MINIMUM_BALANCE_DROPS: drops.default("1500000"),

  XRPL_TESTNET_INTEGRATION: bool.default(false),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Parse and cache the process environment. Throws a readable error listing every
 * invalid variable so misconfiguration fails fast instead of at first payment.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env, { reload = false } = {}): Env {
  if (cached && !reload) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (
    env.XRPL_NETWORK_ID === 0 ||
    /mainnet|xrplcluster\.com|s1\.ripple\.com|s2\.ripple\.com/i.test(env.XRPL_WSS_URL)
  ) {
    throw new Error("Aigentia refuses to run against XRPL Mainnet. Use Testnet or Devnet.");
  }
  if (env.XRPL_WALLET_PROVIDER === "env" && !env.XRPL_WALLET_SEEDS) {
    throw new Error(
      "XRPL_WALLET_PROVIDER=env requires XRPL_WALLET_SEEDS (JSON map of walletRef → seed).",
    );
  }
  cached = env;
  return env;
}

/** Parse the JSON map of walletRef → seed from XRPL_WALLET_SEEDS. */
export function parseWalletSeeds(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  const parsed = z.record(z.string().min(1), z.string().min(1)).safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new Error("XRPL_WALLET_SEEDS must be a JSON object of walletRef → seed");
  return parsed.data;
}

export function resetEnvCache(): void {
  cached = undefined;
}
