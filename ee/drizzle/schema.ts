// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Tables of the commercial `@appstrate/ee` package. They live in the platform
 * database under a journal of their own (`drizzle.appstrate_ee_migrations`), so
 * they reference platform rows by id only: no foreign key crosses the licence
 * boundary, and an organization's rows are dropped on `onOrgDelete`.
 */

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** One organization's enterprise sign-in settings. */
export const ssoConnections = pgTable(
  "sso_connections",
  {
    orgId: uuid("org_id").primaryKey(),
    /** The Entra tenant (`tid`) bound to the organization, read off a real Microsoft sign-in. */
    tenantId: text("tenant_id"),
    tenantLinkedBy: text("tenant_linked_by"),
    tenantLinkedAt: timestamp("tenant_linked_at", { withTimezone: true }),
    /** The org role given to a person who joins by signing in with Microsoft. */
    joinRole: text("join_role").notNull().default("member"),
    /** Set while sign-in is enforced; `null` otherwise. */
    enforcedAt: timestamp("enforced_at", { withTimezone: true }),
    enforcedBy: text("enforced_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("sso_connections_join_role_check", sql`${t.joinRole} IN ('member', 'guest')`),
    // Enforcement needs a tenant to send people to.
    check(
      "sso_connections_enforced_needs_tenant",
      sql`${t.enforcedAt} IS NULL OR ${t.tenantId} IS NOT NULL`,
    ),
  ],
);

/** An email domain an organization claims, and whether it proved it (DNS TXT). */
export const ssoDomains = pgTable(
  "sso_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    domain: text("domain").notNull(),
    verificationToken: text("verification_token").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sso_domains_org_domain_idx").on(t.orgId, t.domain),
    // A verified domain belongs to one organization of the instance.
    uniqueIndex("sso_domains_verified_domain_idx")
      .on(t.domain)
      .where(sql`${t.verifiedAt} IS NOT NULL`),
  ],
);

/**
 * Sessions opened by a Microsoft sign-in, with the tenant that vouched for
 * them. Read to bind a tenant (the owner's own sign-in) and to allow
 * enforcement only from a session of the bound tenant. Kept no longer than a
 * session can live.
 */
export const ssoSessions = pgTable(
  "sso_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    userId: text("user_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sso_sessions_created_at_idx").on(t.createdAt)],
);
