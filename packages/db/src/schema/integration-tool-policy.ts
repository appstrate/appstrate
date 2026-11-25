// SPDX-License-Identifier: Apache-2.0

/**
 * What a remote integration's tool catalog looked like when last listed, and what a space decided
 * about it: the snapshot (one per integration target), the per-space approvals of a tool's
 * definition, and the per-space blocks.
 */

import {
  pgTable,
  text,
  uuid,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";
import { spaces } from "./spaces.ts";
import { packages } from "./packages.ts";
import { integrationConnections } from "./integrations.ts";

/** A tool descriptor as the upstream server listed it (name, description, input schema, …). */
export type ToolDefinition = Record<string, unknown>;

/** One tool of a snapshot. `definition` is null once the catalog outgrows its size cap. */
export interface ToolSnapshotEntry {
  name: string;
  fingerprint: string;
  first_seen_at: string;
  changed_at: string | null;
  definition: ToolDefinition | null;
}

/**
 * The last listing of one integration's tools: per connection when the upstream is authenticated,
 * one row with a NULL `connection_id` otherwise. A truncated listing keeps the tools it did not
 * return; a full one replaces the set.
 */
export const integrationToolSnapshots = pgTable(
  "integration_tool_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id"),
    listedAt: timestamp("listed_at", { withTimezone: true }).defaultNow().notNull(),
    truncated: boolean("truncated").notNull().default(false),
    tools: jsonb("tools").$type<ToolSnapshotEntry[]>().notNull().default([]),
  },
  (table) => [
    // `coalesce` stands in for NULLS NOT DISTINCT, which drizzle offers on `unique()` only, not `uniqueIndex()`.
    uniqueIndex("uq_integration_tool_snapshots_target").on(
      table.orgId,
      table.packageId,
      sql`coalesce(${table.connectionId}::text, '')`,
    ),
    // Composite so a snapshot can only point at a connection of its own organization; MATCH SIMPLE
    // leaves the unauthenticated row (NULL connection) unconstrained.
    foreignKey({
      name: "integration_tool_snapshots_connection_org_fk",
      columns: [table.connectionId, table.orgId],
      foreignColumns: [integrationConnections.id, integrationConnections.orgId],
    }).onDelete("cascade"),
    // FK cascade on connection delete.
    index("idx_integration_tool_snapshots_connection")
      .on(table.connectionId)
      .where(sql`${table.connectionId} IS NOT NULL`),
  ],
);

/**
 * A space's approval of one tool definition. Several fingerprints per tool coexist (two instances
 * behind a templated URL each have their own definition approved).
 */
export const spaceIntegrationToolApprovals = pgTable(
  "space_integration_tool_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spaceId: text("space_id").notNull(),
    orgId: uuid("org_id").notNull(),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    fingerprint: text("fingerprint").notNull(),
    definition: jsonb("definition").$type<ToolDefinition>().notNull(),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "space_integration_tool_approvals_space_org_fk",
      columns: [table.spaceId, table.orgId],
      foreignColumns: [spaces.id, spaces.orgId],
    }).onDelete("cascade"),
    uniqueIndex("uq_space_integration_tool_approvals").on(
      table.spaceId,
      table.packageId,
      table.toolName,
      table.fingerprint,
    ),
  ],
);

/** A tool a space refuses to expose, whatever its definition. */
export const spaceIntegrationToolBlocks = pgTable(
  "space_integration_tool_blocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spaceId: text("space_id").notNull(),
    orgId: uuid("org_id").notNull(),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    blockedBy: text("blocked_by").references(() => user.id, { onDelete: "set null" }),
    blockedAt: timestamp("blocked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "space_integration_tool_blocks_space_org_fk",
      columns: [table.spaceId, table.orgId],
      foreignColumns: [spaces.id, spaces.orgId],
    }).onDelete("cascade"),
    uniqueIndex("uq_space_integration_tool_blocks").on(
      table.spaceId,
      table.packageId,
      table.toolName,
    ),
  ],
);
