CREATE TYPE "public"."agent_status" AS ENUM('active', 'paused', 'bankrupt', 'retired');--> statement-breakpoint
CREATE TYPE "public"."bounty_status" AS ENUM('open', 'claimed', 'paid', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."brain_kind" AS ENUM('deterministic', 'llm');--> statement-breakpoint
CREATE TYPE "public"."decision_outcome" AS ENUM('pending', 'success', 'failed', 'rejected', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('draft', 'running', 'finished', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."invocation_status" AS ENUM('quoted', 'paid', 'fulfilled', 'failed', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('open', 'claimed', 'submitted', 'completed', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('testnet', 'mock');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('open', 'filled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."objective" AS ENUM('maximize_net_worth', 'survive', 'maximize_information', 'maximize_reputation', 'build_coalition', 'information_broker', 'profitable_service');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('x402', 'transfer', 'job_reward', 'bounty', 'trade', 'funding');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('intent', 'denied', 'submitted', 'validated', 'failed');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('ore', 'data', 'energy', 'alloy');--> statement-breakpoint
CREATE TYPE "public"."service_kind" AS ENUM('SCOUT', 'ANALYST', 'COURIER');--> statement-breakpoint
CREATE TYPE "public"."service_status" AS ENUM('active', 'paused', 'retired');--> statement-breakpoint
CREATE TABLE "agent_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"tick" integer NOT NULL,
	"balance_drops" bigint NOT NULL,
	"net_worth_drops" bigint NOT NULL,
	"reputation" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"objective" "objective" NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"brain" "brain_kind" DEFAULT 'deterministic' NOT NULL,
	"brain_model" text,
	"wallet_address" text NOT NULL,
	"wallet_ref" text NOT NULL,
	"balance_drops" bigint DEFAULT 0 NOT NULL,
	"balance_checked_at" timestamp with time zone,
	"reputation" double precision DEFAULT 50 NOT NULL,
	"strategy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget_policy" jsonb NOT NULL,
	"location_id" text NOT NULL,
	"experiment_id" text,
	"starting_capital_drops" bigint DEFAULT 0 NOT NULL,
	"last_tick" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bounties" (
	"id" text PRIMARY KEY NOT NULL,
	"poster_agent_id" text NOT NULL,
	"description" text NOT NULL,
	"reward_drops" bigint NOT NULL,
	"target" jsonb NOT NULL,
	"status" "bounty_status" DEFAULT 'open' NOT NULL,
	"claimed_by_agent_id" text,
	"payment_id" text,
	"created_at_tick" integer NOT NULL,
	"expires_at_tick" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"tick" integer NOT NULL,
	"observation_summary" text NOT NULL,
	"action" jsonb NOT NULL,
	"summary" text NOT NULL,
	"reason" text NOT NULL,
	"rationale" jsonb,
	"cost_drops" bigint,
	"payment_id" text,
	"tx_hash" text,
	"outcome" text,
	"outcome_status" "decision_outcome" DEFAULT 'pending' NOT NULL,
	"brain" text NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" "experiment_status" DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"seed" text NOT NULL,
	"started_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"start_tick" integer,
	"end_tick" integer,
	"results" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"location_id" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"poster_agent_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"reward_drops" bigint NOT NULL,
	"status" "job_status" DEFAULT 'open' NOT NULL,
	"requirement" jsonb,
	"claimed_by_agent_id" text,
	"claimed_at_tick" integer,
	"submission" jsonb,
	"submitted_at_tick" integer,
	"payment_id" text,
	"created_at_tick" integer NOT NULL,
	"expires_at_tick" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"tx_hash" text PRIMARY KEY NOT NULL,
	"ledger" "ledger_kind" NOT NULL,
	"transaction_type" text NOT NULL,
	"sender_address" text NOT NULL,
	"receiver_address" text,
	"asset" text DEFAULT 'XRP' NOT NULL,
	"amount_drops" bigint,
	"fee_drops" bigint,
	"ledger_index" integer NOT NULL,
	"close_time" timestamp with time zone,
	"invoice_id" text,
	"memo" text,
	"result" text NOT NULL,
	"validated" boolean NOT NULL,
	"payment_id" text,
	"raw" jsonb NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_prices" (
	"resource_type" "resource_type" PRIMARY KEY NOT NULL,
	"bid_drops" bigint NOT NULL,
	"ask_drops" bigint NOT NULL,
	"supply" integer DEFAULT 0 NOT NULL,
	"last_tick" integer DEFAULT 0 NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"purpose" "payment_kind" NOT NULL,
	"destination_address" text NOT NULL,
	"destination_agent_id" text,
	"asset" text DEFAULT 'XRP' NOT NULL,
	"amount_drops" bigint NOT NULL,
	"service_category" text,
	"action_kind" text NOT NULL,
	"action_id" text NOT NULL,
	"approved" boolean NOT NULL,
	"policy_decision" jsonb NOT NULL,
	"tick" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"intent_id" text,
	"kind" "payment_kind" NOT NULL,
	"status" "payment_status" NOT NULL,
	"ledger" "ledger_kind" NOT NULL,
	"sender_agent_id" text,
	"receiver_agent_id" text,
	"sender_address" text NOT NULL,
	"receiver_address" text NOT NULL,
	"asset" text DEFAULT 'XRP' NOT NULL,
	"amount_drops" bigint NOT NULL,
	"fee_drops" bigint,
	"tx_hash" text,
	"ledger_index" integer,
	"validated_at" timestamp with time zone,
	"invoice_id" text,
	"action_kind" text,
	"action_id" text,
	"tick" integer NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reputation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"delta" double precision NOT NULL,
	"reason" text NOT NULL,
	"ref_kind" text,
	"ref_id" text,
	"tick" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_listings" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_agent_id" text NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_drops" bigint NOT NULL,
	"status" "listing_status" DEFAULT 'open' NOT NULL,
	"tick" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"location_id" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"base_price_drops" bigint NOT NULL,
	"regen_per_tick" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_invocations" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"seller_agent_id" text NOT NULL,
	"buyer_agent_id" text,
	"buyer_address" text,
	"invoice_id" text NOT NULL,
	"status" "invocation_status" DEFAULT 'quoted' NOT NULL,
	"price_drops" bigint NOT NULL,
	"payment_requirements" jsonb NOT NULL,
	"payment_id" text,
	"tx_hash" text,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response" jsonb,
	"latency_ms" integer,
	"error" text,
	"tick" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_agent_id" text NOT NULL,
	"kind" "service_kind" NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"endpoint" text NOT NULL,
	"price_drops" bigint NOT NULL,
	"asset" text DEFAULT 'XRP' NOT NULL,
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb NOT NULL,
	"status" "service_status" DEFAULT 'active' NOT NULL,
	"successful_calls" integer DEFAULT 0 NOT NULL,
	"failed_calls" integer DEFAULT 0 NOT NULL,
	"total_revenue_drops" bigint DEFAULT 0 NOT NULL,
	"latency_sum_ms" bigint DEFAULT 0 NOT NULL,
	"latency_count" integer DEFAULT 0 NOT NULL,
	"last_called_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulation_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"running" boolean DEFAULT false NOT NULL,
	"current_tick" integer DEFAULT 0 NOT NULL,
	"seed" text DEFAULT 'genesis' NOT NULL,
	"ledger" "ledger_kind" DEFAULT 'testnet' NOT NULL,
	"tick_seconds" integer DEFAULT 60 NOT NULL,
	"last_tick_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	CONSTRAINT "simulation_state_id_check" CHECK ("simulation_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "ticks" (
	"tick" integer PRIMARY KEY NOT NULL,
	"seed" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"agents_processed" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_agent_id" text,
	"seller_agent_id" text,
	"counterparty" text DEFAULT 'agent' NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_drops" bigint NOT NULL,
	"total_drops" bigint NOT NULL,
	"payment_id" text,
	"listing_id" text,
	"tick" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tick" integer NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"agent_id" text,
	"counterparty_id" text,
	"experiment_id" text,
	"tx_hash" text,
	"amount_drops" bigint,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_snapshots" ADD CONSTRAINT "agent_snapshots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_poster_agent_id_agents_id_fk" FOREIGN KEY ("poster_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_claimed_by_agent_id_agents_id_fk" FOREIGN KEY ("claimed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_poster_agent_id_agents_id_fk" FOREIGN KEY ("poster_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_claimed_by_agent_id_agents_id_fk" FOREIGN KEY ("claimed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_destination_agent_id_agents_id_fk" FOREIGN KEY ("destination_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_receiver_agent_id_agents_id_fk" FOREIGN KEY ("receiver_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_listings" ADD CONSTRAINT "resource_listings_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_invocations" ADD CONSTRAINT "service_invocations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_invocations" ADD CONSTRAINT "service_invocations_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_invocations" ADD CONSTRAINT "service_invocations_buyer_agent_id_agents_id_fk" FOREIGN KEY ("buyer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_invocations" ADD CONSTRAINT "service_invocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_buyer_agent_id_agents_id_fk" FOREIGN KEY ("buyer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_seller_agent_id_agents_id_fk" FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_listing_id_resource_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."resource_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "snapshots_agent_tick_idx" ON "agent_snapshots" USING btree ("agent_id","tick");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_idx" ON "agents" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_wallet_address_idx" ON "agents" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "agents_experiment_idx" ON "agents" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "decisions_agent_tick_idx" ON "decisions" USING btree ("agent_id","tick");--> statement-breakpoint
CREATE INDEX "decisions_tick_idx" ON "decisions" USING btree ("tick");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_agent_type_location_idx" ON "inventory_items" USING btree ("agent_id","resource_type","location_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_poster_idx" ON "jobs" USING btree ("poster_agent_id");--> statement-breakpoint
CREATE INDEX "ledger_tx_sender_idx" ON "ledger_transactions" USING btree ("sender_address");--> statement-breakpoint
CREATE INDEX "ledger_tx_receiver_idx" ON "ledger_transactions" USING btree ("receiver_address");--> statement-breakpoint
CREATE INDEX "intents_agent_idx" ON "payment_intents" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tx_hash_idx" ON "payments" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payments_sender_idx" ON "payments" USING btree ("sender_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_receiver_idx" ON "payments" USING btree ("receiver_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reputation_agent_idx" ON "reputation_events" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "listings_status_idx" ON "resource_listings" USING btree ("status","resource_type");--> statement-breakpoint
CREATE UNIQUE INDEX "resources_type_location_idx" ON "resources" USING btree ("resource_type","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invocations_invoice_idx" ON "service_invocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invocations_tx_hash_idx" ON "service_invocations" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "invocations_service_idx" ON "service_invocations" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE INDEX "invocations_buyer_idx" ON "service_invocations" USING btree ("buyer_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_seller_kind_idx" ON "services" USING btree ("seller_agent_id","kind");--> statement-breakpoint
CREATE INDEX "services_kind_status_idx" ON "services" USING btree ("kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "simulation_state_singleton_idx" ON "simulation_state" USING btree ("singleton");--> statement-breakpoint
CREATE INDEX "trades_tick_idx" ON "trades" USING btree ("tick");--> statement-breakpoint
CREATE INDEX "events_tick_idx" ON "world_events" USING btree ("tick");--> statement-breakpoint
CREATE INDEX "events_agent_idx" ON "world_events" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "world_events" USING btree ("type");