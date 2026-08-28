ALTER TABLE "mint_plans" ADD COLUMN "presigned_raw_tx" text;--> statement-breakpoint
ALTER TABLE "mint_plans" ADD COLUMN "presigned_nonce" integer;--> statement-breakpoint
ALTER TABLE "mint_plans" ADD COLUMN "presigned_tx_hash" text;--> statement-breakpoint
ALTER TABLE "mint_plans" ADD COLUMN "presigned_at" timestamp with time zone;