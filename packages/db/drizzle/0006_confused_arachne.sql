CREATE TABLE "registry_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"registry_username" text NOT NULL,
	"registry_user_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "publish_scope" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "publish_name" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "last_published_version" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "last_published_at" timestamp;--> statement-breakpoint
ALTER TABLE "registry_connections" ADD CONSTRAINT "registry_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_registry_connections_user_id" ON "registry_connections" USING btree ("user_id");