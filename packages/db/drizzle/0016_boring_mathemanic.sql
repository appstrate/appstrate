CREATE TABLE "storage_disks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sync_cursor" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_storage_disks_org_name" UNIQUE("org_id","name"),
	CONSTRAINT "storage_disks_kind_values" CHECK (kind IN ('native', 's3', 'google_drive', 'onedrive', 'dropbox'))
);
--> statement-breakpoint
CREATE TABLE "storage_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"disk_id" text NOT NULL,
	"driver_key" text NOT NULL,
	"name" text NOT NULL,
	"mime" text,
	"size_bytes" bigint,
	"visibility" text DEFAULT 'org' NOT NULL,
	"owner_id" text,
	"synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_storage_objects_disk_driver_key" UNIQUE("disk_id","driver_key"),
	CONSTRAINT "storage_objects_visibility_values" CHECK (visibility IN ('org', 'private'))
);
--> statement-breakpoint
ALTER TABLE "storage_disks" ADD CONSTRAINT "storage_disks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_disk_id_storage_disks_id_fk" FOREIGN KEY ("disk_id") REFERENCES "public"."storage_disks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storage_disks_org" ON "storage_disks" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_storage_disks_org_default" ON "storage_disks" USING btree ("org_id") WHERE "storage_disks"."is_default" = true;--> statement-breakpoint
CREATE INDEX "idx_storage_objects_org" ON "storage_objects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_storage_objects_disk" ON "storage_objects" USING btree ("disk_id");