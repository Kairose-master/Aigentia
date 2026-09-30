import { createBrain, type AgentBrain, type LLMProvider } from "@aigentia/agent-core";
import type { Database } from "@aigentia/db";
import {
  BaselineServiceRanker,
  PolicyEngine,
  XRPLPaymentAdapter,
  type PaymentAdapter,
  type ServiceRanker,
  type SpendTracker,
} from "@aigentia/economy";
import { MockPaymentAdapter } from "@aigentia/economy/testing";
import {
  AigentiaError,
  DROPS_PER_XRP,
  createLogger,
  xrpToDrops,
  type Env,
  type Logger,
} from "@aigentia/shared";
import {
  LedgerBalanceReader,
  LedgerPaymentVerifier,
  XRPLClient,
  createWalletProvider,
  xrplConfigFromEnv,
  type PaymentVerifier,
  type WalletProvider,
  type XrplNetworkConfig,
} from "@aigentia/xrpl";
import { MockLedger, MockWalletProvider } from "@aigentia/xrpl/testing";
import { HttpFacilitator, X402Client, type Facilitator, type FetchFn } from "@aigentia/x402";
import { MockFacilitator } from "@aigentia/x402/testing";
import { SellerGate } from "./x402-seller";
import { X402ServicePurchaser } from "./x402-purchaser";
import { createAgent, type CreateAgentInput } from "./agent-factory";
import type { BalanceSource, Clock, TreasuryInfo } from "./context";
import { EventLog, type EventSink } from "./events";
import { DeterministicIdGenerator, RandomIdGenerator, type IdGenerator } from "./ids";
import type { ServiceExecutor } from "./services";
import { InProcessServicePurchaser, Settlement, type ServicePurchaser } from "./settlement";
import { Simulation } from "./simulation";
import { WorldStoreSpendTracker } from "./spend-tracker";
import { InMemoryWorldStore } from "./store/in-memory";
import { PostgresWorldStore } from "./store/postgres";
import type { AgentRecord, WorldStore } from "./store/types";
import { genesisWorld } from "./world";

export interface RuntimeOptions {
  /** Which ledger settles payments. "mock" wires the [MOCK] in-process ledger. */
  readonly ledger: "testnet" | "mock";
  /** Postgres handle; when absent (and no `store`), an InMemoryWorldStore is used. */
  readonly db?: Database;
  readonly store?: WorldStore;
  readonly eventSink?: EventSink;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly ranker?: ServiceRanker;
  readonly spendTracker?: SpendTracker;
  readonly purchaser?: (settlement: Settlement, events: EventLog) => ServicePurchaser;
  /** Override the brain factory (tests inject ScriptedBrain). */
  readonly brainFor?: (agent: AgentRecord) => AgentBrain;
  /** Wrap or replace the payment adapter (tests force failures). */
  readonly adapter?: (adapter: PaymentAdapter) => PaymentAdapter;
  /** Fault injection for the in-process purchaser; defaults to `executeService`. */
  readonly executeService?: ServiceExecutor;
  /** Mock ledger only: XRP minted to the treasury on start (default 1,000,000 XRP). */
  readonly mockTreasuryXrp?: bigint;
  /**
   * How agents buy services. "x402" (default on testnet) goes over HTTP 402 to the seller's
   * endpoint and settles through the facilitator; "in-process" (default on mock) pays directly.
   */
  readonly purchaserMode?: "x402" | "in-process";
  /** Override the facilitator (default: services/x402-xrpl on testnet, [MOCK] on mock). */
  readonly facilitator?: Facilitator;
  /** HTTP client the x402 buyer uses to reach seller endpoints (tests route it in-process). */
  readonly fetch?: FetchFn;
}

export interface Runtime {
  readonly ledger: "testnet" | "mock";
  readonly store: WorldStore;
  readonly sim: Simulation;
  readonly settlement: Settlement;
  readonly purchaser: ServicePurchaser;
  readonly events: EventLog;
  readonly balances: BalanceSource;
  readonly walletProvider: WalletProvider;
  readonly adapter: PaymentAdapter;
  readonly treasury: TreasuryInfo;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly spendTracker: SpendTracker;
  readonly xrplConfig: XrplNetworkConfig | null;
  /** Present only on the mock ledger. */
  readonly mockLedger: MockLedger | null;
  /** x402 resource server for agent services (mounted by the API). */
  readonly sellerGate: SellerGate;
  readonly facilitator: Facilitator;
  readonly purchaserMode: "x402" | "in-process";
  /** Connect the ledger client and resolve the treasury wallet; no-op on the mock ledger. */
  connect(): Promise<void>;
  createAgent(input: CreateAgentInput): Promise<AgentRecord>;
  brainFor(agent: AgentRecord): AgentBrain;
  close(): Promise<void>;
}

/** Model used when LLM_MODEL is empty. OpenAI has no default: set LLM_MODEL explicitly. */
const DEFAULT_LLM_MODEL: Record<LLMProvider, string> = {
  anthropic: "claude-fable-5-1",
  openai: "",
  mock: "mock-model",
};

/** Fee and reserve headroom the treasury keeps above any single funding payment. */
const TREASURY_HEADROOM_DROPS = 2_000_000n;

/** Brain per agent, cached: deterministic or LLM according to the agent row and LLM_* env. */
export function makeBrainFactory(env: Env, logger?: Logger): (agent: AgentRecord) => AgentBrain {
  const cache = new Map<string, AgentBrain>();
  return (agent) => {
    const cached = cache.get(agent.id);
    if (cached) return cached;
    let brain: AgentBrain;
    if (agent.brain === "llm" && env.LLM_PROVIDER !== "none") {
      const provider: LLMProvider = env.LLM_PROVIDER;
      const fromRow = agent.brainModel?.includes("/")
        ? agent.brainModel.split("/").slice(1).join("/")
        : agent.brainModel;
      const modelId = (fromRow && fromRow.trim()) || env.LLM_MODEL || DEFAULT_LLM_MODEL[provider];
      const apiKey =
        provider === "anthropic"
          ? env.ANTHROPIC_API_KEY
          : provider === "openai"
            ? env.OPENAI_API_KEY
            : "";
      brain = createBrain({
        kind: "llm",
        worldSeed: env.SIM_SEED,
        provider,
        modelId,
        ...(apiKey ? { apiKey } : {}),
      });
    } else {
      if (agent.brain === "llm") {
        logger?.warn(
          { agentId: agent.id },
          "LLM_PROVIDER=none: llm agent falls back to the deterministic brain",
        );
      }
      brain = createBrain({ kind: "deterministic", worldSeed: env.SIM_SEED });
    }
    cache.set(agent.id, brain);
    return brain;
  };
}

/**
 * Wire the whole engine for one ledger.
 *   mock    → MockLedger + MockWalletProvider + MockPaymentAdapter (+ in-process purchaser), logs [MOCK]
 *   testnet → XRPLClient + createWalletProvider + LedgerBalanceReader + LedgerPaymentVerifier + XRPLPaymentAdapter
 * The in-process purchaser stands in for the HTTP x402 purchaser until Phase 3.
 */
export async function createRuntime(env: Env, options: RuntimeOptions): Promise<Runtime> {
  if (options.ledger === "mock" && env.NODE_ENV === "production") {
    throw new AigentiaError("VALIDATION_FAILED", "SIM_LEDGER=mock is refused in production");
  }
  const logger = options.logger ?? createLogger("game-engine", env.LOG_LEVEL);
  const clock = options.clock ?? (() => new Date());
  const store =
    options.store ??
    (options.db
      ? new PostgresWorldStore(options.db)
      : new InMemoryWorldStore({ seed: env.SIM_SEED, ledger: options.ledger, clock }));
  await store.seedWorld(genesisWorld(env.SIM_SEED));
  await store.setSimulationState({
    ledger: options.ledger,
    tickSeconds: env.TICK_SECONDS,
    seed: env.SIM_SEED,
  });

  const treasury: { walletRef: string; address: string } = {
    walletRef: env.TREASURY_WALLET_REF,
    address: "",
  };
  let balances: BalanceSource;
  let walletProvider: WalletProvider;
  let adapter: PaymentAdapter;
  let mockLedger: MockLedger | null = null;
  let xrplConfig: XrplNetworkConfig | null = null;
  let client: XRPLClient | null = null;
  let ids: IdGenerator;
  let verifier: PaymentVerifier;
  let facilitator: Facilitator;

  if (options.ledger === "mock") {
    logger.warn(
      "[MOCK] game-engine runtime: settling on the in-process MockLedger, never for production",
    );
    const ledger = new MockLedger();
    const wallets = new MockWalletProvider(env.SIM_SEED);
    treasury.address = await wallets.getAddress(treasury.walletRef);
    ledger.fund(treasury.address, (options.mockTreasuryXrp ?? 1_000_000n) * DROPS_PER_XRP);
    balances = ledger;
    walletProvider = wallets;
    adapter = new MockPaymentAdapter(ledger, wallets);
    mockLedger = ledger;
    verifier = ledger;
    facilitator = options.facilitator ?? new MockFacilitator(ledger, { network: "xrpl:1" });
    ids = options.ids ?? new DeterministicIdGenerator(env.SIM_SEED);
  } else {
    xrplConfig = xrplConfigFromEnv(env);
    client = new XRPLClient(xrplConfig, { logger });
    walletProvider = createWalletProvider(env, xrplConfig, { client, logger });
    balances = new LedgerBalanceReader(client);
    verifier = new LedgerPaymentVerifier(client);
    facilitator =
      options.facilitator ??
      new HttpFacilitator({ baseUrl: env.X402_SERVICE_URL, token: env.X402_SERVICE_TOKEN });
    adapter = new XRPLPaymentAdapter(client, walletProvider, verifier, xrplConfig, {
      logger,
    });
    ids = options.ids ?? new RandomIdGenerator();
  }

  if (options.adapter) adapter = options.adapter(adapter);
  const events = new EventLog(store, options.eventSink);
  const spendTracker = options.spendTracker ?? new WorldStoreSpendTracker(store);
  const policyEngine = new PolicyEngine();
  const settlement = new Settlement({
    store,
    adapter,
    policyEngine,
    spendTracker,
    balances,
    events,
    ids,
    clock,
    treasury,
    logger,
  });
  const network = xrplConfig?.caip2 ?? "xrpl:1";
  const purchaserMode =
    options.purchaserMode ?? (options.ledger === "testnet" ? "x402" : "in-process");
  const sellerGate = new SellerGate({
    store,
    facilitator,
    verifier,
    events,
    ids,
    clock,
    network,
    sourceTag: env.X402_SOURCE_TAG,
    maxTimeoutSeconds: env.X402_MAX_TIMEOUT_SECONDS,
    logger,
    ...(options.executeService ? { executeService: options.executeService } : {}),
  });
  const x402Purchaser = (): ServicePurchaser =>
    new X402ServicePurchaser({
      store,
      settlement,
      events,
      ids,
      clock,
      network,
      sourceTag: env.X402_SOURCE_TAG,
      maxTimeoutSeconds: env.X402_MAX_TIMEOUT_SECONDS,
      logger,
      client: new X402Client({
        facilitator,
        walletProvider,
        verifier,
        network,
        networkId: xrplConfig?.networkId ?? 1,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    });
  const purchaser =
    options.purchaser?.(settlement, events) ??
    (purchaserMode === "x402" ? x402Purchaser() : undefined) ??
    new InProcessServicePurchaser({
      store,
      settlement,
      events,
      ids,
      clock,
      network: xrplConfig?.caip2 ?? "xrpl:1",
      quoteTtlMs: env.X402_MAX_TIMEOUT_SECONDS * 1000,
      ...(options.executeService ? { executeService: options.executeService } : {}),
    });
  const brainFor = options.brainFor ?? makeBrainFactory(env, logger);
  const sim = new Simulation({
    store,
    brainFor,
    settlement,
    purchaser,
    balances,
    spendTracker,
    ranker: options.ranker ?? new BaselineServiceRanker(),
    ids,
    clock,
    worldSeed: env.SIM_SEED,
    apiPublicUrl: env.API_PUBLIC_URL,
    treasury,
    events,
    logger,
  });

  /** [DEV] Top the treasury up from the faucet when it cannot cover the next funding. */
  const ensureTreasuryCovers = async (capitalXrp: number): Promise<void> => {
    if (!walletProvider.topUp || options.ledger !== "testnet") return;
    const needed = xrpToDrops(capitalXrp) + TREASURY_HEADROOM_DROPS;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { spendableDrops } = await balances.getBalanceDrops(treasury.address);
      if (spendableDrops >= needed) return;
      logger.warn(
        { spendableDrops: spendableDrops.toString(), needed: needed.toString() },
        "treasury low; requesting Testnet faucet top-up",
      );
      await walletProvider.topUp(treasury.walletRef);
    }
  };

  const runtime: Runtime = {
    ledger: options.ledger,
    store,
    sim,
    settlement,
    purchaser,
    events,
    balances,
    walletProvider,
    adapter,
    treasury,
    ids,
    clock,
    spendTracker,
    xrplConfig,
    mockLedger,
    sellerGate,
    facilitator,
    purchaserMode,
    async connect(): Promise<void> {
      if (client) {
        await client.connect();
        await client.assertNetwork();
      }
      if (!treasury.address) {
        // Only the treasury is faucet-funded; agents are activated by its funding payment.
        const { address } = await walletProvider.ensureWallet(treasury.walletRef, { fund: true });
        treasury.address = address;
      }
    },
    async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
      if (!treasury.address) {
        throw new AigentiaError("VALIDATION_FAILED", "runtime not connected: call connect() first");
      }
      await ensureTreasuryCovers(input.startingCapitalXrp ?? 10);
      return createAgent(
        store,
        {
          walletProvider,
          settlement,
          events,
          ids,
          clock,
          treasury,
          apiPublicUrl: env.API_PUBLIC_URL,
          policyEnv: env,
          defaultBrainModel:
            env.LLM_PROVIDER === "none" ? null : `${env.LLM_PROVIDER}/${env.LLM_MODEL}`,
        },
        input,
      );
    },
    brainFor,
    async close(): Promise<void> {
      if (client) await client.disconnect();
    },
  };
  return runtime;
}
