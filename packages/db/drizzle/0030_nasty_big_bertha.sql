CREATE TABLE "package_logic_maps" (
	"id" serial PRIMARY KEY NOT NULL,
	"version_id" integer NOT NULL,
	"package_id" text NOT NULL,
	"org_id" uuid,
	"integrity" text NOT NULL,
	"map" jsonb NOT NULL,
	"generator_kind" text NOT NULL,
	"generator_version" text,
	"overall_confidence" double precision,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "package_logic_maps" ADD CONSTRAINT "package_logic_maps_version_id_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_logic_maps" ADD CONSTRAINT "package_logic_maps_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_logic_maps" ADD CONSTRAINT "package_logic_maps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pkg_logic_maps_version_unique" ON "package_logic_maps" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "idx_pkg_logic_maps_package_id" ON "package_logic_maps" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_pkg_logic_maps_org_id" ON "package_logic_maps" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_pkg_logic_maps_integrity" ON "package_logic_maps" USING btree ("integrity");