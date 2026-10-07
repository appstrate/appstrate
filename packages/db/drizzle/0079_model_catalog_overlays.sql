CREATE TABLE "model_catalog_overlays" (
	"sdk_version" text PRIMARY KEY NOT NULL,
	"serial" bigint NOT NULL,
	"payload" text NOT NULL,
	"signature" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
