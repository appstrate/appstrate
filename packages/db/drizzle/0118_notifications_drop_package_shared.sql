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
