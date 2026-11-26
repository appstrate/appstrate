-- `credential_needs_reconnection`: the bell notice an integration connection's owner gets when the
-- connection dies. The kind CHECK names every value of `notificationTypeValues`.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK (type IN ('run_failed', 'package_shared', 'agent_message', 'credential_needs_reconnection'));
