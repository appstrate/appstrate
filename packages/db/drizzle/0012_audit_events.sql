-- 0012_audit_events.sql
--
-- Append-only audit log for state-changing operations. Inserted via the
-- best-effort `recordAudit()` helper in apps/api/src/services/audit.ts.
-- See docs/architecture/AUDIT_TRAIL.md for the schema rationale.

CREATE TABLE IF NOT EXISTS "audit_events" (
  "id"             BIGSERIAL PRIMARY KEY,
  "org_id"         UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "application_id" TEXT REFERENCES "applications"("id") ON DELETE SET NULL,
  "actor_type"     TEXT NOT NULL,
  "actor_id"       TEXT,
  "action"         TEXT NOT NULL,
  "resource_type"  TEXT NOT NULL,
  "resource_id"    TEXT,
  "before"         JSONB,
  "after"          JSONB,
  "ip"             TEXT,
  "user_agent"     TEXT,
  "request_id"     TEXT,
  "created_at"     TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_audit_events_org_created"
  ON "audit_events" ("org_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_audit_events_resource"
  ON "audit_events" ("resource_type", "resource_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_audit_events_actor"
  ON "audit_events" ("actor_type", "actor_id");
