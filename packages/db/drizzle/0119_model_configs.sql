-- Model configurations (#2451): a model belongs to a configuration, not to a credential.
--
-- `model_configs` holds one configuration per (org, catalog family), or per (org, provider,
-- endpoint) for a gateway provider. A connection (`model_provider_credentials`), a model
-- (`org_models`) and a pairing gain a nullable `config_id`. No row is rewritten here (migrations
-- carry no DML): `scripts/migration/0062-model-configs.ts` fills `config_id` on every connection
-- and model, merges the duplicates the fold creates and drops the org setting
-- `personal_model_credentials`; the platform refuses to boot until it has run. The follow-up
-- release sets `config_id` NOT NULL and drops the retired columns
-- (`model_provider_credentials.base_url_override`, `org_models.provider_id`,
-- `org_models.credential_id`). `org_models.provider_id` turns nullable so a new model needs none.
--
-- Dropped: the CHECK tying an alias to a credential, the composite FK naming a model's credential
-- and provider (and the unique index on the credential side it needed), and the two per-binding
-- unique indexes, replaced by one per (configuration, model) among non-aliased rows.
--
-- LOCK AND COST. Every ALTER takes ACCESS EXCLUSIVE on tables that hold one row per credential,
-- model or pairing (short); every new column is nullable without a default (catalog-only), and
-- the new indexes are built on columns that are all NULL.
CREATE TABLE "model_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"personal_connections_allowed" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_models" DROP CONSTRAINT "org_models_alias_bound";--> statement-breakpoint
ALTER TABLE "org_models" DROP CONSTRAINT "org_models_credential_provider_fk";
--> statement-breakpoint
DROP INDEX "uq_model_provider_credentials_id_provider_id";--> statement-breakpoint
DROP INDEX "uq_org_models_unaliased_binding";--> statement-breakpoint
DROP INDEX "uq_org_models_unbound";--> statement-breakpoint
ALTER TABLE "org_models" ALTER COLUMN "provider_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD COLUMN "config_id" uuid;--> statement-breakpoint
ALTER TABLE "model_provider_pairings" ADD COLUMN "config_id" uuid;--> statement-breakpoint
ALTER TABLE "org_models" ADD COLUMN "config_id" uuid;--> statement-breakpoint
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_model_configs_org_id" ON "model_configs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_model_configs_created_by" ON "model_configs" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_model_configs_family" ON "model_configs" USING btree ("org_id","provider_id") WHERE "model_configs"."base_url" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_model_configs_endpoint" ON "model_configs" USING btree ("org_id","provider_id","base_url") WHERE "model_configs"."base_url" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD CONSTRAINT "model_provider_credentials_config_id_model_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."model_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_pairings" ADD CONSTRAINT "model_provider_pairings_config_id_model_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."model_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_models" ADD CONSTRAINT "org_models_config_id_model_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."model_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_model_provider_credentials_config_id" ON "model_provider_credentials" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "idx_model_provider_pairings_config_id" ON "model_provider_pairings" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "idx_org_models_config_id" ON "org_models" USING btree ("config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_models_config_model" ON "org_models" USING btree ("config_id","model_id") WHERE "org_models"."aliased" = false;