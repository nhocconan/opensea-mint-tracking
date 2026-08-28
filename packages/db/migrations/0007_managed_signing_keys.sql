ALTER TABLE "wallets" ADD COLUMN "encrypted_signing_key" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "signing_key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "signing_key_added_at" timestamp with time zone;