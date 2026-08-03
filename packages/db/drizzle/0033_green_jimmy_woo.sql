ALTER TABLE "runs" ADD COLUMN "chat_session_id" text;--> statement-breakpoint

-- Promote the chat-owned relationship previously stored in metadata. Only
-- backfill a session in the same org, so stale or malformed JSON cannot make
-- the tenant-integrity FK fail. Remove the legacy key in either case: from this
-- migration onward the dedicated column is the sole source of truth.
UPDATE "runs" AS r
SET "chat_session_id" = r."metadata"->>'chatSessionId'
FROM "chat_sessions" AS s
WHERE r."metadata" ? 'chatSessionId'
  AND s."id" = r."metadata"->>'chatSessionId'
  AND s."org_id" = r."org_id";--> statement-breakpoint

UPDATE "runs"
SET "metadata" = NULLIF("metadata" - 'chatSessionId', '{}'::jsonb)
WHERE "metadata" ? 'chatSessionId';--> statement-breakpoint

-- Column-list SET NULL detaches only chat_session_id. A plain composite SET
-- NULL would also null the NOT-NULL org_id and make session deletion fail.
ALTER TABLE "runs" ADD CONSTRAINT "runs_chat_session_id_org_id_fk" FOREIGN KEY ("chat_session_id","org_id") REFERENCES "public"."chat_sessions"("id","org_id") ON DELETE SET NULL ("chat_session_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_runs_chat_session_started" ON "runs" USING btree ("chat_session_id","started_at") WHERE "runs"."chat_session_id" IS NOT NULL;
