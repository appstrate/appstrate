-- 0096 — invariants the writers already hold, stated by the database. Every constraint is added
-- validated, so a row breaking one fails this migration instead of being excused.
-- `connection_calls`: an index on `created_at` for a sweep by age, and the two principal kinds
-- `Actor` admits (`owner_type` stays NULL when the connection was gone at call time).
-- `org_models`: an alias is bound to a credential, and a bound model's `provider_id` is its
-- credential's — 0087 copied it from the credential, every writer takes it from there, and no
-- writer rewrites a credential's provider (ON UPDATE CASCADE carries it if one ever is). The
-- composite foreign key replaces the single-column one and keeps its ON DELETE RESTRICT; MATCH
-- SIMPLE leaves an unbound row (NULL credential) unchecked.
-- `model_provider_pairings`: the owner is the organization or the minter, and a consumed redeem
-- ends with a credential or a failure, never both.
CREATE INDEX "idx_connection_calls_created_at" ON "connection_calls" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_actor_type_valid" CHECK (actor_type IN ('user', 'end_user'));--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_owner_type_valid" CHECK (owner_type IS NULL OR owner_type IN ('user', 'end_user'));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_model_provider_credentials_id_provider_id" ON "model_provider_credentials" USING btree ("id","provider_id");--> statement-breakpoint
ALTER TABLE "org_models" DROP CONSTRAINT "org_models_credential_id_model_provider_credentials_id_fk";--> statement-breakpoint
ALTER TABLE "org_models" ADD CONSTRAINT "org_models_credential_provider_fk" FOREIGN KEY ("credential_id","provider_id") REFERENCES "public"."model_provider_credentials"("id","provider_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "org_models" ADD CONSTRAINT "org_models_alias_bound" CHECK (NOT aliased OR credential_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "model_provider_pairings" ADD CONSTRAINT "model_provider_pairings_owner_is_minter" CHECK (owner_user_id IS NULL OR owner_user_id = user_id);--> statement-breakpoint
ALTER TABLE "model_provider_pairings" ADD CONSTRAINT "model_provider_pairings_outcome_single" CHECK (NOT (credential_id IS NOT NULL AND failed_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "model_provider_pairings" ADD CONSTRAINT "model_provider_pairings_failed_consumed" CHECK (failed_at IS NULL OR consumed_at IS NOT NULL);
