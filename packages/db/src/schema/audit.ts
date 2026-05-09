import { pgTable, text, timestamp, bigserial, jsonb, uuid, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.ts";
import { applications } from "./applications.ts";

/**
 * Append-only audit log for state-changing operations. Insert via
 * `recordAudit()` from `apps/api/src/services/audit.ts` — the helper is
 * best-effort (never throws) so it can be added to any mutation path
 * without changing its failure modes.
 *
 * `actor_type` is open-ended on purpose: today's vocabulary is
 * `user` / `end_user` / `api_key` / `system`, but module-owned mutations
 * (oidc client provisioning, …) may add their own kinds without a schema
 * migration.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: text("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_audit_events_org_created").on(table.orgId, table.createdAt),
    index("idx_audit_events_resource").on(table.resourceType, table.resourceId),
    index("idx_audit_events_actor").on(table.actorType, table.actorId),
  ],
);
