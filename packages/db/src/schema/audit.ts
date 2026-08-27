import { pgTable, text, timestamp, bigserial, jsonb, uuid, index } from "drizzle-orm/pg-core";

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
 *
 * `org_id` is a denormalized reference, **not** a foreign key. An audit log
 * is an immutable historical record: it must outlive the entities it
 * describes. A FK to `organizations` would force a deleting org to either
 * cascade-wipe its own audit trail (defeating the audit) or block on the
 * constraint — so the `org.deleted` tombstone keeps the deleted org's id as
 * a plain value with no referential dependency.
 *
 * `space_id` is the same, and for the same reason — since `0055`. It used to
 * carry a real FK to `spaces` with `ON DELETE SET NULL`, which is the failure
 * that argument exists to prevent, applied to the other tenancy column:
 * `DELETE /api/spaces/:id` is a live route (`services/spaces.ts`), and every
 * historical row for that space silently lost its attribution the moment it
 * ran. Nothing reconstructs which space it was — `action` is a verb and
 * `resource_id` names the resource, not its container — so the rows survived
 * as an audit trail nobody can scope. Deleting a space is exactly when its
 * trail matters most.
 *
 * Dropping the FK also removes the referencing-side seq-scan that space
 * deletion paid to find the rows to blank, inside the transaction already
 * holding the organizations row lock (the class `0050` fixed for the
 * recipient deletes and `0055` finishes for the space delete).
 *
 * The cost, stated rather than discovered: nothing stops a `space_id` naming
 * a space that no longer exists. That is the intended posture — the same one
 * `org_id` has always had — not an oversight to be repaired with a FK later.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    spaceId: text("space_id"),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_audit_events_org_created").on(table.orgId, table.createdAt),
    index("idx_audit_events_resource").on(table.resourceType, table.resourceId),
    index("idx_audit_events_actor").on(table.actorType, table.actorId),
  ],
);
