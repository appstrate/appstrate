ALTER TABLE "executions" DROP CONSTRAINT "executions_package_version_id_package_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_package_version_id_package_versions_id_fk" FOREIGN KEY ("package_version_id") REFERENCES "public"."package_versions"("id") ON DELETE set null ON UPDATE no action;
