-- Keep space-scoped read markers and grants in their owning organization.
ALTER TABLE "run_reads" ADD CONSTRAINT "run_reads_space_org_fk" FOREIGN KEY ("space_id","org_id") REFERENCES "public"."spaces"("id","org_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_reads" DROP CONSTRAINT "run_reads_space_id_spaces_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_grant_states" ADD CONSTRAINT "oauth_grant_states_space_org_fk" FOREIGN KEY ("space_id","org_id") REFERENCES "public"."spaces"("id","org_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_grant_states" DROP CONSTRAINT "oauth_grant_states_space_id_spaces_id_fk";
