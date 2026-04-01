CREATE TABLE "org_profile_provider_bindings" (
	"org_profile_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"source_profile_id" uuid NOT NULL,
	"bound_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_profile_provider_bindings_org_profile_id_provider_id_pk" PRIMARY KEY("org_profile_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "flow_provider_bindings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "flow_provider_bindings" CASCADE;--> statement-breakpoint
ALTER TABLE "user_provider_connections" DROP CONSTRAINT "user_provider_connections_connected_by_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "idx_user_provider_connections_connected_by";--> statement-breakpoint
ALTER TABLE "org_profile_provider_bindings" ADD CONSTRAINT "org_profile_provider_bindings_org_profile_id_connection_profiles_id_fk" FOREIGN KEY ("org_profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_profile_provider_bindings" ADD CONSTRAINT "org_profile_provider_bindings_source_profile_id_connection_profiles_id_fk" FOREIGN KEY ("source_profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_profile_provider_bindings" ADD CONSTRAINT "org_profile_provider_bindings_bound_by_user_id_user_id_fk" FOREIGN KEY ("bound_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_profile_bindings_source" ON "org_profile_provider_bindings" USING btree ("source_profile_id");--> statement-breakpoint
CREATE INDEX "idx_org_profile_bindings_user" ON "org_profile_provider_bindings" USING btree ("bound_by_user_id");--> statement-breakpoint
ALTER TABLE "user_provider_connections" DROP COLUMN "connected_by_user_id";