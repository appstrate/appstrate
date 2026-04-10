-- Provider Management module: initial schema

CREATE TABLE IF NOT EXISTS "org_provider_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "api" text NOT NULL,
  "base_url" text NOT NULL,
  "api_key_encrypted" text NOT NULL,
  "created_by" text REFERENCES "user" ("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "api" text NOT NULL,
  "base_url" text NOT NULL,
  "model_id" text NOT NULL,
  "provider_key_id" uuid NOT NULL REFERENCES "org_provider_keys" ("id") ON DELETE CASCADE,
  "input" jsonb,
  "context_window" integer,
  "max_tokens" integer,
  "reasoning" boolean,
  "cost" jsonb,
  "enabled" boolean DEFAULT true NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "source" text DEFAULT 'custom' NOT NULL,
  "created_by" text REFERENCES "user" ("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_provider_keys_org_id" ON "org_provider_keys" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_models_org_id" ON "org_models" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_org_models_one_default" ON "org_models" USING btree ("org_id") WHERE "is_default" = true;
