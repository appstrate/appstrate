CREATE TABLE "browser_connection_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" text NOT NULL,
	"integration_package_id" text NOT NULL,
	"auth_key" text NOT NULL,
	"user_id" text,
	"end_user_id" text,
	"connection_id" uuid,
	"target_provider" text NOT NULL,
	"profile_ref" text,
	"proxy_config_encrypted" text,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"handoff_encrypted" text,
	"interaction_encrypted" text,
	"error_code" text,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_connection_attempts_exactly_one_owner" CHECK (("browser_connection_attempts"."user_id" IS NOT NULL AND "browser_connection_attempts"."end_user_id" IS NULL) OR ("browser_connection_attempts"."user_id" IS NULL AND "browser_connection_attempts"."end_user_id" IS NOT NULL)),
	CONSTRAINT "browser_connection_attempts_auth_key_valid" CHECK ("browser_connection_attempts"."auth_key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "browser_connection_attempts_provider_valid" CHECK ("browser_connection_attempts"."target_provider" IN ('browser-use-cloud', 'process')),
	CONSTRAINT "browser_connection_attempts_status_valid" CHECK ("browser_connection_attempts"."status" IN ('pending', 'claimed', 'state_received', 'provisioning', 'interaction_required', 'complete', 'failed', 'expired', 'cancelled')),
	CONSTRAINT "browser_connection_attempts_token_hash_valid" CHECK ("browser_connection_attempts"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "browser_connection_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"profile_ref" text NOT NULL,
	"proxy_config_encrypted" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_connection_bindings_provider_valid" CHECK ("browser_connection_bindings"."provider" IN ('browser-use-cloud', 'process')),
	CONSTRAINT "browser_connection_bindings_status_valid" CHECK ("browser_connection_bindings"."status" IN ('ready', 'interaction_required', 'invalid', 'deleting')),
	CONSTRAINT "browser_connection_bindings_profile_ref_bounded" CHECK (length("browser_connection_bindings"."profile_ref") BETWEEN 1 AND 512),
	CONSTRAINT "browser_connection_bindings_state_version_positive" CHECK ("browser_connection_bindings"."state_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "browser_profile_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"profile_ref" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_profile_deletions_provider_valid" CHECK ("browser_profile_deletions"."provider" IN ('browser-use-cloud', 'process')),
	CONSTRAINT "browser_profile_deletions_profile_ref_bounded" CHECK (length("browser_profile_deletions"."profile_ref") BETWEEN 1 AND 512),
	CONSTRAINT "browser_profile_deletions_attempts_valid" CHECK ("browser_profile_deletions"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "browser_session_leases" (
	"binding_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"fencing_token" bigint DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_session_leases_owner_bounded" CHECK (length("browser_session_leases"."owner_id") BETWEEN 1 AND 256),
	CONSTRAINT "browser_session_leases_fencing_positive" CHECK ("browser_session_leases"."fencing_token" > 0)
);
--> statement-breakpoint
ALTER TABLE "browser_connection_attempts" ADD CONSTRAINT "browser_connection_attempts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_connection_attempts" ADD CONSTRAINT "browser_connection_attempts_integration_package_id_packages_id_fk" FOREIGN KEY ("integration_package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_connection_attempts" ADD CONSTRAINT "browser_connection_attempts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_connection_attempts" ADD CONSTRAINT "browser_connection_attempts_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_connection_attempts" ADD CONSTRAINT "browser_connection_attempts_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_connection_bindings" ADD CONSTRAINT "browser_connection_bindings_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_session_leases" ADD CONSTRAINT "browser_session_leases_binding_id_browser_connection_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."browser_connection_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_connection_attempts_token_hash_unique" ON "browser_connection_attempts" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "browser_connection_attempts_expiry_idx" ON "browser_connection_attempts" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "browser_connection_attempts_actor_user_idx" ON "browser_connection_attempts" USING btree ("user_id") WHERE "browser_connection_attempts"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "browser_connection_attempts_actor_end_user_idx" ON "browser_connection_attempts" USING btree ("end_user_id") WHERE "browser_connection_attempts"."end_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_connection_bindings_connection_unique" ON "browser_connection_bindings" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "browser_connection_bindings_provider_status_idx" ON "browser_connection_bindings" USING btree ("provider","status");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_profile_deletions_provider_ref_unique" ON "browser_profile_deletions" USING btree ("provider","profile_ref");--> statement-breakpoint
CREATE INDEX "browser_profile_deletions_due_idx" ON "browser_profile_deletions" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "browser_session_leases_expiry_idx" ON "browser_session_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."enqueue_browser_binding_profile_deletion_fn"()
RETURNS trigger AS $$
BEGIN
	INSERT INTO "public"."browser_profile_deletions" ("provider", "profile_ref", "next_attempt_at")
	VALUES (
		OLD."provider",
		OLD."profile_ref",
		COALESCE(
			(
				SELECT "expires_at"
				FROM "public"."browser_session_leases"
				WHERE "binding_id" = OLD."id" AND "expires_at" > now()
			),
			now()
		)
	)
	ON CONFLICT ("provider", "profile_ref") DO NOTHING;
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER enqueue_browser_binding_profile_deletion
	BEFORE DELETE ON "public"."browser_connection_bindings"
	FOR EACH ROW
	EXECUTE FUNCTION "public"."enqueue_browser_binding_profile_deletion_fn"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."enqueue_browser_attempt_profile_deletion_fn"()
RETURNS trigger AS $$
BEGIN
	IF OLD."profile_ref" IS NOT NULL AND OLD."status" <> 'complete' THEN
		INSERT INTO "public"."browser_profile_deletions" ("provider", "profile_ref")
		VALUES (OLD."target_provider", OLD."profile_ref")
		ON CONFLICT ("provider", "profile_ref") DO NOTHING;
	END IF;
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER enqueue_browser_attempt_profile_deletion
	BEFORE DELETE ON "public"."browser_connection_attempts"
	FOR EACH ROW
	EXECUTE FUNCTION "public"."enqueue_browser_attempt_profile_deletion_fn"();
