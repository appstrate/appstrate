-- How an offer reaches the spaces that hold no row of their own: `available` (placed, switched on by
-- the space) or `on_by_default` (placed and active). The column is added with a DEFAULT only so the
-- rows that exist keep meaning what an offer has always meant here, `on_by_default`; the DEFAULT is
-- dropped at once, so every later insert states its mode. No data is rewritten.
ALTER TABLE "org_package_offers" ADD COLUMN "mode" text DEFAULT 'on_by_default' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_package_offers" ALTER COLUMN "mode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "org_package_offers" ADD CONSTRAINT "org_package_offers_mode_known" CHECK (mode IN ('available', 'on_by_default'));
