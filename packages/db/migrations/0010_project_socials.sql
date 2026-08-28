ALTER TABLE "projects" ADD COLUMN "twitter_username" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "project_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "discord_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "safelist_status" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "socials_fetched_at" timestamp with time zone;
