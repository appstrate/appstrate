// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  integer,
  unique,
  check,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.ts";

// Search tables — owned by the core schema (modules own no tables), consumed
// by the `@appstrate/module-search` workspace module. Behaviour (ingestion
// pipeline, hybrid retrieval, the storage→search event seam, route, UI) lives
// in `packages/module-search`.
//
// search is a CONTENT-AGNOSTIC capability: it indexes what it is handed and
// answers queries. It does NOT own the files — `storage` does. The link to a
// stored file is the OPAQUE object id (`storageObjectId`), carried as plain
// text with NO foreign key to `storage_objects`: the coupling is LOOSE, driven
// by the event contract (`object.deleted` evicts, `object.acl_changed`
// re-scopes — see module-storage/src/events.ts), never a SQL cascade. That is
// the strategy §5 rule — events, never JOIN.

// The registry: one row per indexed storage object. Tracks ingestion status
// and holds the item-level ACL copy (storage stays the source of truth; this
// copy is re-synced on `object.acl_changed`). `name` is captured at ingestion
// (read from the storage metadata) so a search hit can show a title without a
// cross-module lookup.
export const searchItems = pgTable(
  "search_items",
  {
    id: text("id").primaryKey(), // sidx_ prefix
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // The opaque storage object handle — TEXT, never a FK (loose coupling).
    storageObjectId: text("storage_object_id").notNull(),
    name: text("name"),
    mime: text("mime"),
    // ACL copy (storage = source of truth, re-synced on object.acl_changed):
    //   `org`     — visible to every member of the org
    //   `private` — visible to its owner only
    visibility: text("visibility").notNull().default("org").$type<"org" | "private">(),
    ownerId: text("owner_id"),
    status: text("status").notNull().default("pending").$type<"pending" | "indexed" | "failed">(),
    // Last successful indexing.
    syncedAt: timestamp("synced_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // One registry row per object per org — the upsert key on object.upserted.
    unique("uq_search_items_org_object").on(table.orgId, table.storageObjectId),
    index("idx_search_items_org").on(table.orgId),
    check("search_items_visibility_values", sql`visibility IN ('org', 'private')`),
    check("search_items_status_values", sql`status IN ('pending', 'indexed', 'failed')`),
  ],
);

// The index proper. `orgId` / `visibility` / `ownerId` are DENORMALISED here
// (copied from the item) so the retrieval query filters ACL inside the index
// scan — never a live JOIN against an ACL table (strategy §5bis: a JOIN against
// a permissions table kills the ANN traversal; post-filtering a top-K leaks via
// counts/ranking). Rights and ranking live in one WHERE clause.
//
// `embedding` holds the nomic-embed-text-v1.5 vector (768 dims, computed
// in-process by Transformers.js). The column is GUARDED in the migration: on a
// Postgres without the pgvector binaries it is simply absent (boot never
// breaks) and search degrades to keyword matching — which is why queries always
// select explicit columns and never write `embedding` unless the capability
// check passed.
export const searchChunks = pgTable(
  "search_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Internal FK — search owns both tables, so a cascade here is fine (this is
    // NOT the cross-module coupling; that one is searchItems.storageObjectId).
    searchItemId: text("search_item_id")
      .notNull()
      .references(() => searchItems.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    visibility: text("visibility").notNull().default("org").$type<"org" | "private">(),
    ownerId: text("owner_id"),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 768 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uq_search_chunks_item_index").on(table.searchItemId, table.chunkIndex),
    index("idx_search_chunks_org").on(table.orgId),
  ],
);
