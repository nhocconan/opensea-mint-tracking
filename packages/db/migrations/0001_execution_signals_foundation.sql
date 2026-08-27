CREATE TABLE "execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text NOT NULL,
	"simulation_result" jsonb,
	"tx_hash" text,
	"rpc_endpoint_id" uuid,
	"gas_used" bigint,
	"effective_gas_price_wei" text,
	"error_code" text,
	"attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mint_plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"stage_id" uuid,
	"signer_id" uuid,
	"wallet_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"per_plan_ceiling_wei" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"armed_at" timestamp with time zone,
	"armed_until" timestamp with time zone,
	"armed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rpc_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"chain_id" integer NOT NULL,
	"label" text NOT NULL,
	"http_url" text NOT NULL,
	"ws_url" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"credential_id" uuid,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid,
	"subject" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"score" integer NOT NULL,
	"confidence" text DEFAULT 'unverified' NOT NULL,
	"evidence" jsonb,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"chain_id" integer NOT NULL,
	"owner_address" text NOT NULL,
	"scheme" text NOT NULL,
	"delegate_contract_address" text,
	"session_key_credential_id" uuid,
	"onchain_spend_ceiling_wei" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_plan_id_mint_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."mint_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_rpc_endpoint_id_rpc_endpoints_id_fk" FOREIGN KEY ("rpc_endpoint_id") REFERENCES "public"."rpc_endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mint_plans" ADD CONSTRAINT "mint_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mint_plans" ADD CONSTRAINT "mint_plans_stage_id_drop_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."drop_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mint_plans" ADD CONSTRAINT "mint_plans_signer_id_signers_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."signers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mint_plans" ADD CONSTRAINT "mint_plans_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mint_plans" ADD CONSTRAINT "mint_plans_armed_by_user_id_user_id_fk" FOREIGN KEY ("armed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rpc_endpoints" ADD CONSTRAINT "rpc_endpoints_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signers" ADD CONSTRAINT "signers_session_key_credential_id_credentials_id_fk" FOREIGN KEY ("session_key_credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_attempts_plan_idx" ON "execution_attempts" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "execution_attempts_status_idx" ON "execution_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mint_plans_status_idx" ON "mint_plans" USING btree ("status","armed_until");--> statement-breakpoint
CREATE INDEX "rpc_endpoints_chain_idx" ON "rpc_endpoints" USING btree ("chain_id","enabled","priority");--> statement-breakpoint
CREATE INDEX "signals_project_idx" ON "signals" USING btree ("project_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "signals_subject_idx" ON "signals" USING btree ("subject","source");--> statement-breakpoint
CREATE INDEX "signers_owner_idx" ON "signers" USING btree ("chain_id","owner_address");