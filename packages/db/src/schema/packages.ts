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

export const packageConfigs = pgTable(
  "package_configs",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    packageId: text("package_id").notNull(),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.packageId] }),
    index("idx_package_configs_org_id").on(table.orgId),
  ],
);

export const packages = pgTable(
  "packages",
  {
    id: text("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: packageTypeEnum("type").notNull(),
    source: packageSourceEnum("source").notNull().default("local"),
    name: text("name").notNull(),
    manifest: jsonb("manifest"),
    content: text("content"),
    displayName: text("display_name"),
    description: text("description"),
    registryScope: text("registry_scope"),
    registryName: text("registry_name"),
    registryVersion: text("registry_version"),
    autoInstalled: boolean("auto_installed").notNull().default(false),
    lastPublishedVersion: text("last_published_version"),
    lastPublishedAt: timestamp("last_published_at"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_packages_org_id").on(table.orgId),
    index("idx_packages_type").on(table.type),
    check("packages_id_slug", sql`${table.id} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`),
  ],
);

export const packageVersions = pgTable(
  "package_versions",
  {
    id: serial("id").primaryKey(),
    packageId: text("package_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("package_versions_pkg_version_unique").on(table.packageId, table.versionNumber),
    index("idx_package_versions_package_id").on(table.packageId, table.versionNumber),
  ],
);

export const packageDependencies = pgTable(
  "package_dependencies",
  {
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    dependencyId: text("dependency_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.packageId, table.dependencyId] }),
    index("idx_package_dependencies_dep_id").on(table.dependencyId),
  ],
);
