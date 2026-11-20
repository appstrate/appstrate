CREATE TABLE "oauth_grant_states" (
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" text,
	"tokens_valid_after" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_grant_states_user_id_client_id_resource_pk" PRIMARY KEY("user_id","client_id","resource")
);
--> statement-breakpoint
ALTER TABLE "oauth_grant_states" ADD CONSTRAINT "oauth_grant_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grant_states" ADD CONSTRAINT "oauth_grant_states_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grant_states" ADD CONSTRAINT "oauth_grant_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grant_states" ADD CONSTRAINT "oauth_grant_states_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oauth_grant_states_client" ON "oauth_grant_states" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_grant_states_org" ON "oauth_grant_states" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_grant_states_space" ON "oauth_grant_states" USING btree ("space_id");