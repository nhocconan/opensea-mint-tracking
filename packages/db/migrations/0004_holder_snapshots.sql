CREATE TABLE "holder_snapshots" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_minted" integer NOT NULL,
	"unique_holders" integer NOT NULL,
	"top_holders" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "holder_snapshots" ADD CONSTRAINT "holder_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;