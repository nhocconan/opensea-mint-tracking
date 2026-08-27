CREATE TABLE "rarity_snapshots" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_tokens" integer NOT NULL,
	"top_rarest" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rarity_snapshots" ADD CONSTRAINT "rarity_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;