CREATE TABLE "mint_activity_snapshots" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"unique_recipients" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mint_activity_snapshots" ADD CONSTRAINT "mint_activity_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
