// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  serial,
  uuid,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { packageTypeEnum, packageSourceEnum } from "./enums.ts";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";
import { applications } from "./applications.ts";
import { connectionProfiles } from "./connections.ts";

export const applicationPackages = pgTable(
  "application_packages",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    versionId: integer("version_id").references(() => packageVersions.id, {
      onDelete: "set null",
    }),
    config: jsonb("config").notNull().default({}),
    modelId: text("model_id"),
    proxyId: text("proxy_id"),
    appProfileId: uuid("app_profile_id").references(() => connectionProfiles.id, {
      onDelete: "set null",
    }),
    enabled: boolean("enabled").notNull().default(true),
    installedAt: timestamp("installed_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.applicationId, table.packageId] }),
    index("idx_application_packages_package_id").on(table.packageId),
    index("idx_application_packages_app_profile_id").on(table.appProfileId),
    index("idx_application_packages_app_id").on(table.applicationId),
  ],
);

export const packages = pgTable(
  "packages",
  {
    id: text("id").primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    type: packageTypeEnum("type").notNull(),
    source: packageSourceEnum("source").notNull().default("local"),
    draftManifest: jsonb("draft_manifest"),
    draftContent: text("draft_content"),
    autoInstalled: boolean("auto_installed").notNull().default(false),
    // Inline-run shadow packages (transient manifests submitted via
    // POST /api/runs/inline). Hidden from all package/agent list, search,
    // and detail endpoints. NEVER hard-delete an ephemeral row: cascade
    // would wipe the associated `runs` history. Compaction NULLs the
    // content after retention (see inline-compaction worker).
    ephemeral: boolean("ephemeral").notNull().default(false),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    lockVersion: integer("lock_version").notNull().default(1),
    forkedFrom: text("forked_from"),
  },
  (table) => [
    index("idx_packages_org_id").on(table.orgId),
    index("idx_packages_type").on(table.type),
    index("idx_packages_org_type").on(table.orgId, table.type),
    // Partial index sized for the compaction sweep (`ephemeral = true AND
    // created_at < now() - interval '30 days'`). Keeps the hot set tiny.
    index("idx_packages_ephemeral_created")
      .on(table.createdAt)
      .where(sql`${table.ephemeral} = true`),
    check("packages_id_format", sql`${table.id} ~ '^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$'`),
  ],
);

export const packageVersions = pgTable(
  "package_versions",
  {
    id: serial("id").primaryKey(),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    integrity: text("integrity").notNull(),
    artifactSize: integer("artifact_size").notNull(),
    manifest: jsonb("manifest").notNull(),
    yanked: boolean("yanked").notNull().default(false),
    yankedReason: text("yanked_reason"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("package_versions_pkg_version_unique").on(table.packageId, table.version),
    index("idx_package_versions_package_id").on(table.packageId),
  ],
);

export const packageDistTags = pgTable(
  "package_dist_tags",
  {
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    versionId: integer("version_id")
      .notNull()
      .references(() => packageVersions.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.packageId, table.tag] })],
);

export const packageVersionDependencies = pgTable(
  "package_version_dependencies",
  {
    id: serial("id").primaryKey(),
    versionId: integer("version_id")
      .notNull()
      .references(() => packageVersions.id, { onDelete: "cascade" }),
    depScope: text("dep_scope").notNull(),
    depName: text("dep_name").notNull(),
    depType: packageTypeEnum("dep_type").notNull(),
    versionRange: text("version_range").notNull(),
  },
  (table) => [
    uniqueIndex("pkg_ver_deps_unique").on(
      table.versionId,
      table.depScope,
      table.depName,
      table.depType,
    ),
    index("idx_pkg_ver_deps_version_id").on(table.versionId),
  ],
);
