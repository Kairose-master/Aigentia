# Aigentia Architecture

> Working contract for every package. If code and this document disagree, fix one of them in the same commit.

## Principles

1. **XRPL is economic truth.** Every claim that value moved references a validated ledger transaction (`payments.tx_hash`, unique). Never fake an on-chain transaction. The only non-XRPL ledger is the `[MOCK]` in-process ledger used by tests and `SIM_LEDGER=mock` local dev, and everything it produces is labelled `ledger: "mock"` end to end.
2. **x402 is machine-to-machine commerce.** Agents buy services from each other over HTTP 402 using the XRPL `exact` presigned-Payment scheme, protocol-compatible with the official `x402-xrpl` Python SDK, which is isolated in `services/x402-xrpl`.
3. **The game server is a deterministic world simulation.** Given a seed and `DeterministicAgent` brains, two runs on the mock ledger produce identical state.
4. **The LLM only ever produces a `Decision`** (`@aigentia/protocol` `decisionSchema`). It never sees seeds, never builds or signs transactions, never touches the database. Invalid output fails closed to `WAIT`.
5. **Money moves only through** `Decision → ActionValidator → PaymentIntent → PolicyEngine → PaymentAdapter → (x402 | XRPL) → PaymentReceipt`.

## Package graph

```
shared ─┬─ protocol ─┬─ db
        │            ├─ agent-core
        │            ├─ xrpl ──────┐
        │            ├─ x402 ──────┤  (x402 depends on xrpl for signing)
        │            └─ economy ───┘  (economy depends on xrpl + x402 adapters' interfaces only)
        └──────────── game-engine  (depends on db, economy, agent-core, xrpl, x402)
apps/api, apps/worker → game-engine (+ everything)     apps/web → protocol (DTO types only)
services/x402-xrpl (Python) ← HTTP ← packages/x402
```

Packages are consumed as TypeScript source (`exports: { ".": "./src/index.ts" }`), run with `tsx`, and transpiled by Next via `transpilePackages`. Strict TS, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. Money is `bigint` drops in code and `string` drops on the wire.

## Domain model (packages/db)

Tables: `agents, locations, resources, market_prices, inventory_items, resource_listings, services, service_invocations, jobs, bounties, trades, payment_intents, payments, ledger_transactions, reputation_events, decisions, world_events, ticks, agent_snapshots, experiments, simulation_state`.

- `agents.wallet_ref` is an opaque handle resolved by a `WalletProvider`; seeds are never in the database.
- `payments.tx_hash` and `payments.invoice_id` are unique: one ledger transaction settles exactly one game payment; one x402 invoice is paid at most once.
- `service_invocations.invoice_id` unique; `service_invocations.tx_hash` unique.

## Tick loop (packages/game-engine)

```
Simulation.runTick(tick):
  world = store.loadWorld(tick)
  for agent in activeAgents sorted by id:            # deterministic order
    obs      = ObservationBuilder.build(agent, world)                 # OBSERVE
    decision = brain.decide(obs)  → Zod decisionSchema.safeParse       # PLAN + SELECT ACTION (+ summarizeReason)
             invalid → action=WAIT, event ACTION_INVALID, trace outcomeStatus="invalid"
    check    = ActionValidator.validate(agent, decision.action, world) # VALIDATE (semantic: ownership, existence, price ceilings, policy pre-check)
             rejected → event ACTION_REJECTED, trace outcomeStatus="rejected"
    result   = ActionExecutor.execute(agent, action, ctx)             # EXECUTE (+ SETTLE for economic actions)
    store.recordDecision(trace); store.appendEvents(result.events)    # RECORD OUTCOME
    brain.reflectOnOutcome(obs, decision, result) → agent.strategy    # LEARN
  store.snapshotAgents(tick); market.step(tick); jobs.expire(tick)
```

`ActionExecutor` handlers (one per action type) return `ExecutionResult { status: "success"|"failed"|"rejected", outcome: string, costDrops?: bigint, paymentId?, txHash?, events: WorldEventInput[], effects: StateEffect[] }`.

Economic handlers call `Settlement.pay(intent)`:

```
PaymentIntent (from action) → PolicyEngine.evaluate(intent, {policy, balance, spendTracker})
   denied  → payments row status="denied", event PAYMENT_DENIED, handler returns "rejected"
   approved→ PaymentAdapter.execute(intent) → PaymentReceipt (txHash, ledgerIndex, validatedAt)
             → payments row status="validated" (or "failed"), events PAYMENT_SUBMITTED/VALIDATED/FAILED
```

## Interfaces (authoritative signatures)

```ts
// packages/xrpl
interface WalletProvider {
  ensureWallet(walletRef: string): Promise<{ address: string; created: boolean }>;
  getAddress(walletRef: string): Promise<string>;
  sign(walletRef: string, unsignedTx: Record<string, unknown>): Promise<{ txBlob: string; hash: string }>;
}
interface XRPLClient {           // wraps xrpl.js Client (WSS) with reconnect
  connect(): Promise<void>; disconnect(): Promise<void>;
  request<T>(cmd: Record<string, unknown>): Promise<T>;
  autofill(tx): Promise<tx>; submitAndWait(txBlob: string): Promise<{ hash; ledgerIndex; result; validated; meta }>;
  networkId(): number;
}
interface BalanceReader { getBalanceDrops(address): Promise<{ balanceDrops: bigint; reserveDrops: bigint; spendableDrops: bigint }> }
interface PaymentVerifier {
  verify(txHash: string, expect: { destination: string; amountDrops: bigint; asset: Asset; sender?: string; invoiceId?: string }): Promise<VerifiedPayment>  // throws PAYMENT_UNVERIFIED
}
interface TransactionIndexer { indexAddress(address, sinceLedger?): Promise<LedgerTxRecord[]> }
// Mock (tests + SIM_LEDGER=mock): class MockLedger implements XRPLClient-ish + BalanceReader + PaymentVerifier, deterministic hashes = sha256(seed, seq). Exported from "@aigentia/xrpl/testing" and named Mock*.

// packages/economy
interface SpendTracker { spentSince(agentId, since: Date): Promise<bigint> }
class PolicyEngine { evaluate(intent: PaymentIntent, ctx: { policy: BudgetPolicy; balanceDrops: bigint; reserveDrops: bigint; spentLastHourDrops: bigint; spentLastDayDrops: bigint; now: Date }): PolicyDecision }
interface PaymentAdapter { readonly ledger: "testnet"|"mock"; execute(intent: PaymentIntent, ctx: { walletRef: string; tick: number }): Promise<PaymentReceipt> }  // throws AigentiaError PAYMENT_FAILED
interface ServiceRanker { rank(candidates: RankableService[], ctx: { taskKind: ServiceKind; maxPriceDrops?: bigint; tick: number }): RankedService[] }
class BaselineServiceRanker implements ServiceRanker  // score = relevance*successRate*reputationNorm*freshness − normPrice − normLatency
Reputation: applyReputationEvent(kind) → delta, clamp 0..100. Kinds: SERVICE_SUCCESS_SELLER(+1), SERVICE_SUCCESS_BUYER(+0.25), SERVICE_FAILED_SELLER(-3), JOB_COMPLETED_WORKER(+2), JOB_COMPLETED_POSTER(+1), JOB_FAILED_WORKER(-3), PAYMENT_FAILED_BUYER(-1), PAYMENT_DENIED_BUYER(-0.5)

// packages/agent-core
interface AgentBrain {
  readonly kind: "deterministic" | "llm"; readonly model: string;
  observe(obs: Observation): Promise<ObservationView>;        // compress/annotate what matters
  plan(view: ObservationView): Promise<Plan>;                 // candidate actions with expected value
  chooseAction(plan: Plan): Promise<Decision>;                // exactly one validated Decision
  summarizeReason(decision: Decision, plan: Plan): Promise<string>;
  reflectOnOutcome(obs: Observation, decision: Decision, outcome: ExecutionOutcome): Promise<Record<string, unknown>>; // new strategy memory
  decide(obs: Observation): Promise<Decision>;                // observe→plan→chooseAction→summarizeReason, always Zod-validated
}
class DeterministicAgent implements AgentBrain  // seeded by (worldSeed, agentId, tick); strategy by objective; NO randomness outside SeededRandom
class LLMAgentBrain implements AgentBrain       // Vercel AI SDK, provider-neutral; Output.object(decisionSchema); on any error → WAIT decision

// packages/game-engine
interface WorldStore { ...loadWorld, getAgent, updateAgent, listServices, createInvocation, ..., transaction(fn) }   // InMemoryWorldStore (deterministic tests) + PostgresWorldStore (drizzle)
interface EventBus { publish(e: WorldEvent): Promise<void>; subscribe(fn): () => void }   // InMemoryEventBus, RedisEventBus (apps)
class Simulation { constructor(deps); runTick(): Promise<TickResult> }
Services: executeService(kind, input, ctx) → validated output (pure functions over WorldStore); SCOUT lists resource deposits, ANALYST computes market trend/recommendation, COURIER moves inventory between locations (charges distance).

// packages/x402 (buyer + seller helpers)
class X402Client {
  discoverService(kind, ctx): Promise<PaidService[]>
  requestService(service, input): Promise<{ status: 402; paymentRequired: X402PaymentRequired } | { status: 200; body }>
  handle402(body: unknown, expect: { network; asset; maxAmount; payTo; sourceTag; facilitatorId? }): X402PaymentRequirements   // validate network, asset, amount, destination, facilitator, source tag → fail closed (X402_UNTRUSTED / X402_MALFORMED)
  authorizePayment(req, intent): Promise<PolicyDecision>  // delegates to PolicyEngine
  obtainReceipt(req, walletRef): Promise<{ paymentSignatureHeader; txHash; invoiceId }>  // facilitator /payer/build → validate unsigned tx → WalletProvider.sign → header
  retryWithReceipt(service, input, header): Promise<{ body; settlement: X402SettlementResponse }>
  verifyResult(service, body, settlement): Promise<VerifiedServiceResult>  // outputSchema + PaymentVerifier on settlement.transaction
  purchase(...) orchestrates the above
}
class FacilitatorClient { supported(); verify(); settle(); payerBuild() }   // HTTP to services/x402-xrpl with X-Internal-Token
class MockFacilitator implements FacilitatorClient-shape  // [MOCK] tests only, settles on MockLedger
Seller: createPaymentRequired(service, invoiceId, env) → 402 body; SellerGate.accept(header, invocation) → verify → settle → receipt (idempotent by invoiceId / txHash)
```

## x402 purchase flow (agent-to-agent)

```
Buyer worker                         Seller API (apps/api)                Python x402 service           XRPL Testnet
BUY_SERVICE decision
 → POST /services/:id/invoke ───────▶ no PAYMENT-SIGNATURE → create invocation(quoted, invoiceId)
 ◀──── 402 PaymentRequired ───────────
 handle402 (validate all fields)
 PolicyEngine.evaluate(intent)
 POST /payer/build ──────────────────────────────────────────────────▶ build+autofill unsigned Payment (memo=invoiceId, InvoiceID=sha256, SourceTag, LastLedgerSequence)
 validate unsigned tx vs intent; WalletProvider.sign → txBlob, hash
 → POST /services/:id/invoke + PAYMENT-SIGNATURE ▶ SellerGate: invoice lookup, idempotency
                                      POST /verify ─────────────────▶ decode blob, check dest/amount/invoice/network/signature
                                      POST /settle ─────────────────▶ submit blob ───────────────────▶ validated tx
                                      record payment(validated, txHash), execute service, store response
 ◀──── 200 + PAYMENT-RESPONSE (settlement) ───
 verifyResult: outputSchema + PaymentVerifier.verify(txHash) on ledger; record buyer payment, reputation, events
```

Safety checks on the buyer before any PaymentIntent: `network === env.XRPL caip2`, `asset ∈ policy.allowedAssets`, `amount ≤ action.maxPriceDrops` and `≤ service.priceDrops` from our marketplace record, `payTo === seller's registered wallet address`, `extra.facilitator` (if present) `∈ trusted`, `extra.sourceTag === env.X402_SOURCE_TAG` (if present), `maxTimeoutSeconds ≤ env.X402_MAX_TIMEOUT_SECONDS`, `scheme === "exact"`, exactly one `accepts` chosen. Any failure → `X402_UNTRUSTED`/`X402_MALFORMED`, no payment.

## API (apps/api, Fastify)

```
GET  /health
GET  /api/stats                        → StatsDto
GET  /api/world                        → WorldDto
GET  /api/agents?experimentId=         → AgentSummaryDto[]
GET  /api/agents/:id                   → AgentProfileDto
GET  /api/market?kind=                 → ServiceListingDto[] (ranked)
GET  /api/jobs?status=                 → JobDto[]
GET  /api/transactions?cursor=&limit=  → { payments: PaymentDto[], nextCursor }
GET  /api/events?after=&limit=         → eventsPageDto
GET  /api/events/stream                → SSE of SseEnvelope (event | stats | heartbeat)
GET  /api/experiments, /api/experiments/:id → ExperimentDto
POST /api/admin/agents                 (X-Admin-Token) CreateAgentRequest → AgentSummaryDto
POST /api/admin/experiments            (X-Admin-Token) ExperimentConfig  → ExperimentDto
POST /api/admin/experiments/:id/start | /finish
POST /api/admin/sim/start | /stop | /tick   (tick = run one tick now)
POST /services/:id/invoke              x402-protected seller endpoint (402 → PAYMENT-SIGNATURE → 200 + PAYMENT-RESPONSE)
```

Explorer links: `${XRPL_EXPLORER_URL}/transactions/${txHash}` and `/accounts/${address}` for testnet; mock receipts have `explorerUrl: null`.

## Testing rules

- Unit/integration tests never call a paid LLM or the network. Use `DeterministicAgent`, `MockLedger`, `MockFacilitator`, `MockLanguageModel` from `ai/test`.
- One opt-in Testnet test: `XRPL_TESTNET_INTEGRATION=1 pnpm test:testnet` (funds a wallet via faucet, sends 1 drop, verifies).
- Postgres-backed tests use `DATABASE_URL` when set, otherwise skip; the deterministic simulation test runs on `InMemoryWorldStore`.
- Required scenarios: overspend blocked; minimum reserve blocked; invalid LLM output fails closed; duplicate x402 receipts idempotent; payment failure grants no service; success/failure updates reputation; job cannot be claimed twice; one tx hash cannot settle two purchases; deterministic simulation; testnet adapter connects (opt-in).

## Mock labelling rule

Anything that stands in for the ledger or the facilitator is a class named `Mock*`, lives under `src/testing/` or `src/mock/`, logs a `[MOCK]` warning on construction, and sets `ledger: "mock"` on everything it produces. Production wiring (`SIM_LEDGER=testnet`) must never instantiate one.
