-- `agent_message`: an in-app notification an agent sends from inside its run (the `notify` tool of
-- `@appstrate/platform`). The kind CHECK names every value of `notificationTypeValues`.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK (type IN ('run_completed', 'package_shared', 'agent_message'));
