// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  index,
  bigint,
  boolean,
  unique,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.ts";

// Storage tables — owned by the core schema (modules own no tables),
// consumed by the `@appstrate/module-storage` workspace module. Behaviour
// (driver abstraction, disk CRUD, upload/download/delete, on-demand cloud
// sync, read-by-id, UI) lives in `packages/module-storage`.
//
// The model is the appstrate-ws disk/driver layer (strategy §4.1), not the
// read-only documents connectors: a DISK is a backend you operate through a
// `StorageDriver`, and an OBJECT is a file inventoried from it. v1 ships:
//   - a NATIVE default disk per org (the platform S3/FS via `@appstrate/db
//     /storage` — the same facade the core uploads use): upload/download/
//     delete are first-class;
//   - CLOUD disks (S3 buckets, Google Drive) connected with credentials kept
//     encrypted on the disk row: connect + browse + read-by-id.
//
// Out of v1 (later, with their consumer — see module-storage/src/events.ts):
// folder tree, file editor, cross-disk move, and the search index registry.

// A disk is one storage backend: the native default (S3/FS of the core), a
// connected S3 bucket, a Google Drive… `config` carries the driver-specific
// connection settings (bucket/prefix + encrypted secret, drive folder ids +
// encrypted refresh token, etc.). The native default disk carries no config.
export const storageDisks = pgTable(
  "storage_disks",
  {
    id: text("id").primaryKey(), // sdsk_ prefix
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // `native` = the built-in default disk (platform S3/FS). The rest are
    // connected cloud backends.
    kind: text("kind").notNull().$type<"native" | "s3" | "google_drive" | "onedrive" | "dropbox">(),
    name: text("name").notNull(),
    // Exactly one disk per org is the default (the native one) — uploads with
    // no explicit disk land here.
    isDefault: boolean("is_default").notNull().default(false),
    config: jsonb("config").notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    // Incremental sync cursor for cloud disks (Drive modifiedTime watermark,
    // S3 LastModified watermark…).
    syncCursor: text("sync_cursor"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_storage_disks_org").on(table.orgId),
    unique("uq_storage_disks_org_name").on(table.orgId, table.name),
    // At most one default disk per org.
    uniqueIndex("uq_storage_disks_org_default")
      .on(table.orgId)
      .where(sql`${table.isDefault} = true`),
    check(
      "storage_disks_kind_values",
      sql`kind IN ('native', 's3', 'google_drive', 'onedrive', 'dropbox')`,
    ),
  ],
);

// A storage object = one file on a disk. The `id` is the STABLE OPAQUE HANDLE
// consumers hold (chat attachments, agents, the future search index) — never
// the `driverKey`. `visibility`/`ownerId` make storage the SOURCE OF TRUTH
// for the object ACL (the search index will denormalise a copy and re-sync
// via the event contract — see module-storage/src/events.ts).
export const storageObjects = pgTable(
  "storage_objects",
  {
    id: text("id").primaryKey(), // sobj_ prefix — the opaque handle
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    diskId: text("disk_id")
      .notNull()
      .references(() => storageDisks.id, { onDelete: "cascade" }),
    // INTERNAL key the disk's driver reads/writes bytes by (native: the
    // generated storage path; S3: the object key; Drive: the file id). Also
    // the dedup key for cloud sync. Never exposed to consumers (they hold
    // `id`).
    driverKey: text("driver_key").notNull(),
    name: text("name").notNull(),
    mime: text("mime"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    // ACL (storage = source of truth):
    //   `org`     — visible to every member of the org (ownerId = provenance)
    //   `private` — visible to its owner only
    visibility: text("visibility").notNull().default("org").$type<"org" | "private">(),
    ownerId: text("owner_id"),
    // When the object was last seen/refreshed from the disk (cloud sync); for
    // native uploads it equals createdAt.
    syncedAt: timestamp("synced_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("uq_storage_objects_disk_driver_key").on(table.diskId, table.driverKey),
    index("idx_storage_objects_org").on(table.orgId),
    index("idx_storage_objects_disk").on(table.diskId),
    check("storage_objects_visibility_values", sql`visibility IN ('org', 'private')`),
  ],
);
