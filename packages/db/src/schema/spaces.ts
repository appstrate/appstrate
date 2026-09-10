// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  index,
  uniqueIndex,
  jsonb,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";
import { SPACE_ROLE_PRESETS, SPACE_VISIBILITIES } from "@appstrate/core/permissions";

export const spaces = pgTable(
  "spaces",
  {
    id: text("id").primaryKey(), // spc_ prefix
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    settings: jsonb("settings").notNull().default({}),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    /**
     * Who reaches this space without an explicit `space_members` row
     * (RBAC spec §3.1): `open` — every org `member`, with {@link defaultRole};
     * `closed` — nobody (listed, not enterable); `private` — nobody, and the
     * space is not even listed. Owners and admins reach every space regardless.
     */
    visibility: text("visibility", { enum: SPACE_VISIBILITIES }).notNull().default("open"),
    /** Preset the implicit members of an `open` space hold. */
    defaultRole: text("default_role", { enum: SPACE_ROLE_PRESETS }).notNull().default("operator"),
    /**
     * The one member this space belongs to — "Mon espace" — or NULL for a team
     * space (RBAC spec §3.6). A personal space is reached by its owner and by
     * NOBODY else: `resolveSpaceRole` answers on this column before it looks at
     * the org role, so an owner or admin of the organization gets nothing here.
     *
     * `ON DELETE RESTRICT`, not cascade: a user who owns a space leaves through
     * the offboarding sweeper (`orphanedAt` below), which empties the space and
     * deletes it. A cascade would drop somebody's private drafts as a side
     * effect of an account deletion nothing had reviewed.
     */
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "restrict" }),
    /**
     * When the owner stopped being a member of the organization. `removeMember`
     * stamps it; the `personal-space-sweeper` worker empties and deletes the
     * space 30 days later; re-joining clears it. NULL on every team space.
     */
    orphanedAt: timestamp("orphaned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_spaces_org_id").on(table.orgId),
    uniqueIndex("idx_spaces_one_default")
      .on(table.orgId)
      .where(sql`${table.isDefault} = true`),
    // One personal space per member per org — and the conflict target
    // `ensurePersonalSpace` upserts on, which is what makes provisioning a
    // single statement rather than a select-then-insert race.
    uniqueIndex("uq_spaces_org_owner")
      .on(table.orgId, table.ownerUserId)
      .where(sql`${table.ownerUserId} IS NOT NULL`),
    check("spaces_visibility_valid", sql`visibility IN ('open', 'closed', 'private')`),
    check(
      "spaces_default_role_valid",
      sql`default_role IN ('admin', 'builder', 'operator', 'runner', 'viewer')`,
    ),
    // The default space is where a new org member lands, so it can never stop
    // being reachable by one.
    check("spaces_default_is_open", sql`NOT is_default OR visibility = 'open'`),
    // "Personal" has to mean one thing: nobody else reaches it, and it is never
    // the space a new member lands in. Both halves are refused by the API with
    // a 409 naming the rule; these are the backstop.
    check("spaces_personal_is_private", sql`owner_user_id IS NULL OR visibility = 'private'`),
    check("spaces_personal_not_default", sql`owner_user_id IS NULL OR NOT is_default`),
    check("spaces_orphaned_is_personal", sql`orphaned_at IS NULL OR owner_user_id IS NOT NULL`),
  ],
);

/**
 * Org-defined bundles of space-level permissions (RBAC spec §3.3). The four
 * presets are code, not rows — this table holds only the custom bundles.
 *
 * `permissions` is validated against the loaded space-level vocabulary at
 * write time; a string that later becomes unknown (module unloaded) is
 * dropped at resolve time, so `Set.has` never sees it.
 */
export const spaceRoles = pgTable(
  "space_roles",
  {
    id: text("id").primaryKey(), // srl_ prefix
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    permissions: text("permissions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_space_roles_org_key").on(table.orgId, table.key),
    // Referencing-side index for the `user` SET NULL action.
    index("idx_space_roles_created_by").on(table.createdBy),
    check(
      "space_roles_key_not_preset",
      sql`key NOT IN ('admin', 'builder', 'operator', 'runner', 'viewer')`,
    ),
  ],
);

/**
 * Explicit space membership (RBAC spec §5). Exactly one of `presetRole` /
 * `customRoleId` is set — presets are enforced by CHECK, customs by FK, so
 * neither half can hold a value the resolver cannot read.
 *
 * Owners and admins are never rows here: their access is implied by the org
 * role, an explicit row is refused at write (409) and deleted on promotion.
 */
export const spaceMembers = pgTable(
  "space_members",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    presetRole: text("preset_role", { enum: SPACE_ROLE_PRESETS }),
    // RESTRICT, not CASCADE: deleting a role someone still holds is a 409
    // naming the count, never a silent loss of access.
    customRoleId: text("custom_role_id").references(() => spaceRoles.id, { onDelete: "restrict" }),
    addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.userId] }),
    index("idx_space_members_user_id").on(table.userId),
    index("idx_space_members_custom_role_id").on(table.customRoleId),
    // Referencing-side index for the `user` SET NULL action.
    index("idx_space_members_added_by").on(table.addedBy),
    check("space_members_one_role", sql`num_nonnulls(preset_role, custom_role_id) = 1`),
    check(
      "space_members_preset_valid",
      sql`preset_role IS NULL OR preset_role IN ('admin', 'builder', 'operator', 'runner', 'viewer')`,
    ),
  ],
);

export const endUsers = pgTable(
  "end_users",
  {
    id: text("id").primaryKey(), // eu_ prefix
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    name: text("name"),
    email: text("email"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_end_users_external_id")
      .on(table.spaceId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    uniqueIndex("idx_end_users_space_email")
      .on(table.spaceId, table.email)
      .where(sql`email IS NOT NULL`),
    index("idx_end_users_space_id").on(table.spaceId),
    index("idx_end_users_org_id").on(table.orgId),
  ],
);
