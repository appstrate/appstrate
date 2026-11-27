-- How an offer reaches the spaces that hold no row of their own: `available` (placed, switched on by
-- the space) or `on_by_default` (placed and active). The column is added with a DEFAULT only so the
-- rows that exist keep meaning what an offer has always meant here, `on_by_default`; the DEFAULT is
-- dropped at once, so every later insert states its mode. No data is rewritten.
ALTER TABLE "org_package_offers" ADD COLUMN "mode" text DEFAULT 'on_by_default' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_package_offers" ALTER COLUMN "mode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "org_package_offers" ADD CONSTRAINT "org_package_offers_mode_known" CHECK (mode IN ('available', 'on_by_default'));--> statement-breakpoint
-- `package_shared` leaves `notificationTypeValues`: a package is no longer shared with a person, so no
-- notification announces it. The kind CHECK names every value of `notificationTypeValues`.
--
-- NOT VALID, deliberately. Existing `package_shared` rows still sit in `notifications` when this
-- applies, and the rows that predate a CHECK must not abort the batch. `NOT VALID` governs every
-- INSERT and UPDATE from the moment it is added, which is the half that matters here;
-- `scripts/migration/0059-personal-space-audience.ts` deletes the `package_shared` rows and ends with
-- `ALTER TABLE notifications VALIDATE CONSTRAINT notifications_type_valid;` to take the other half.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK (type IN ('run_failed', 'agent_message', 'credential_needs_reconnection')) NOT VALID;
