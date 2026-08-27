ALTER TABLE "mint_plans" ADD COLUMN "cached_tx" jsonb;--> statement-breakpoint
ALTER TABLE "mint_plans" ADD COLUMN "cached_tx_at" timestamp with time zone;