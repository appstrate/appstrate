-- The visual identity `{ icon, color }` of organizations and spaces (#2046): `icon` is `lucide:<name>`, `emoji:<one emoji>`
-- or an inline `data:image/webp;base64,` image (an `emoji:` logo stays valid as is); `color` is a palette key, NULL = derived from the id.
ALTER TABLE "organizations" RENAME COLUMN "logo" TO "icon";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "icon" text;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_icon_length" CHECK (octet_length(icon) <= 16384);--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_icon_length" CHECK (octet_length(icon) <= 16384);
