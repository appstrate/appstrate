-- The visual identity `{ icon, color }` of organizations and spaces (#2046): `icon` is `lucide:<name>`, `emoji:<one emoji>`
-- or, on an organization, an inline `data:image/webp;base64,` or `data:image/png;base64,` image; `color` is a palette key, NULL =
-- derived from the id. A renamed `emoji:` logo is still drawn as is (an `emoji:` value is read leniently); only a write checks it
-- is one RGI emoji. A leftover `image:<uuid>` logo is cleared by `scripts/migration/0049`, run in the same window.
ALTER TABLE "organizations" RENAME COLUMN "logo" TO "icon";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "icon" text;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_icon_length" CHECK (octet_length(icon) <= 16384);--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_icon_length" CHECK (octet_length(icon) <= 16384);
