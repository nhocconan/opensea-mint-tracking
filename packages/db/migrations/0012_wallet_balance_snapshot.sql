ALTER TABLE "wallets" ADD COLUMN "native_balance_wei" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "balance_checked_at" timestamp with time zone;