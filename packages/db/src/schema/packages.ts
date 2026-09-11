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
import { spaces } from "./spaces.ts";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";

export const spacePackages = pgTable(
  "space_packages",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    versionId: integer("version_id").references(() => packageVersions.id, {
      onDelete: "set null",
    }),
    // The agent's stored input settings for this space, in one
    // document:
    //   `values` — editor-set defaults for the agent's INPUT fields (AFPS
    //     `input.schema`). Layer 2 of the four-layer input resolution —
    //     author default (JSON Schema `default`) < editor default < schedule
    //     values < run-time caller input.
    //   `locked` — input field names the editor froze. A locked field is not
    //     overridable at launch: run-time input and schedule values naming one
    //     are refused (400 `locked_input_field`), so its effective value is
    //     always the author default merged with `values` above.
    // The wire pairs these as `values` / `locked_fields`; inside the column
    // the name `input_settings` already supplies the noun.
    inputSettings: jsonb("input_settings")
      .$type<{ values: Record<string, unknown>; locked: string[] }>()
      .notNull()
      .default({ values: {}, locked: [] }),
    modelId: text("model_id"),
    generationConfig: jsonb("generation_config").$type<ModelGenerationSettings>(),
    proxyId: text("proxy_id"),
    // Per-(space, integration) admin lock. Only meaningful for
    // integration packages — set true to refuse user/end-user attempts
    // to create their own connection on this integration in this space
    // (POST /api/integration-connections returns 403). Existing user
    // connections stay functional; the lock is on creation only. The
    // intended workflow: admin enables this → connects → marks the
    // connection sharedWithOrg → users fall through resolution onto
    // the single admin-shared connection. Stored on space_packages
    // because the gate is per-(space, integration) and spacePackages
    // already keys on those (when type=integration).
    blockUserConnections: boolean("block_user_connections").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.packageId] }),
    index("idx_space_packages_package_id").on(table.packageId),
  ],
);

/**
 * Package sharing — AUDIENCE, not installation (RBAC spec §6.10).
 *
 * A row here says "this package is OFFERED to that space". It grants READ (the
 * metadata a recipient needs to decide, and the "add to my space" affordance)
 * and NOTHING else: running a package, resolving its pins, resolving its
 * credentials all read `space_packages`, which the recipient writes for
 * themselves by accepting. That separation is the whole point of a second
 * table — an agent runs with the recipient's credentials, so activating it has
 * to be the recipient's own act, and a state carried on `space_packages` would
 * have had to be filtered at each of its readers, where one miss executes a
 * package nobody consented to.
 *
 * Revoking a share deletes the installation it backs, in the same transaction.
 *
 * `shared_by` is `SET NULL` rather than `RESTRICT`: the sharer leaving the
 * organization must not keep the audience alive as a foreign-key obstacle, and
 * the audit event records who shared it anyway.
 */
export const packageShares = pgTable(
  "package_shares",
  {
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    sharedBy: text("shared_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.packageId, table.spaceId] }),
    // "What is shared WITH this space" — the library's `shared` section and the
    // read predicate both ask it, and it backs the `spaces` cascade.
    index("idx_package_shares_space_id").on(table.spaceId),
    // Referencing-side index for the `user` SET NULL action.
    index("idx_package_shares_shared_by").on(table.sharedBy),
  ],
);

export const packages = pgTable(
  "packages",
  {
    id: text("id").primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    // WHO MAY WRITE THIS PACKAGE — the one authority, read by
    // `assertPackageMutationAccess` (`apps/api/src/lib/package-access.ts`).
    // Holding `<type>:write` in THIS space is what authorizes editing,
    // publishing, renaming and deleting the package; every other space it is
    // installed in consumes it and never gains a say. NULL means the
    // organization catalogue: owners and admins in session, nobody else
    // (`managesOrgCatalog`). It is also a READ grant — a draft never installed
    // anywhere is still readable at home.
    //
    // `ON DELETE RESTRICT`: dropping a space that homes packages would
    // silently promote them to the org catalogue, widening who may write them.
    // `deleteSpace` therefore refuses with 409 `space_homes_packages` and names
    // them, so moving them stays the caller's act. Inline shadow rows are left
    // homeless for the same reason: one run must not wedge its space.
    homeSpaceId: text("home_space_id").references(() => spaces.id, { onDelete: "restrict" }),
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
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    lockVersion: integer("lock_version").notNull().default(1),
    forkedFrom: text("forked_from"),
  },
  (table) => [
    index("idx_packages_type").on(table.type),
    index("idx_packages_org_type").on(table.orgId, table.type),
    // Referencing-side index for the `user` SET NULL action (0048).
    // Postgres indexes only the REFERENCED side of a foreign key; without
    // this, deleting one user seq-scans this table under the deletion's lock.
    index("idx_packages_created_by").on(table.createdBy),
    // Referencing-side index for the `spaces` RESTRICT action, and for the
    // "what does this space home" sweep the write guard and the offboarding
    // path both run.
    index("idx_packages_home_space_id").on(table.homeSpaceId),
    // Partial index sized for the compaction sweep (`ephemeral = true AND
    // created_at < now() - interval '30 days'`). Keeps the hot set tiny.
    index("idx_packages_ephemeral_created")
      .on(table.createdAt)
      .where(sql`${table.ephemeral} = true`),
    check("packages_id_format", sql`${table.id} ~ '^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$'`),
    // AFPS 0.1 shape gate: refuse persisting a draft manifest that declares a
    // non-0.x `schema_version`. Forward-major (1.x/2.x) manifests are rejected
    // per AFPS §2.4 — no back-compat reader, no rewrite path. Permissive when
    // `schema_version` is absent so in-flight drafts survive untouched.
    check(
      "packages_draft_manifest_v0",
      sql`"draft_manifest" IS NULL OR ("draft_manifest" ->> 'schema_version') IS NULL OR ("draft_manifest" ->> 'schema_version') LIKE '0.%'`,
    ),
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
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("package_versions_pkg_version_unique").on(table.packageId, table.version),
    // Referencing-side index for the `user` SET NULL action (0048).
    // Postgres indexes only the REFERENCED side of a foreign key; without
    // this, deleting one user seq-scans this table under the deletion's lock.
    index("idx_package_versions_created_by").on(table.createdBy),
    // AFPS 0.1 shape gate: published version snapshots MUST carry a 0.x
    // `schema_version` when present. Mirrors the draft-side gate on `packages`
    // so the wire and the persisted snapshot never disagree.
    check(
      "package_versions_manifest_v0",
      sql`"manifest" IS NULL OR ("manifest" ->> 'schema_version') IS NULL OR ("manifest" ->> 'schema_version') LIKE '0.%'`,
    ),
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.packageId, table.tag] })],
);

/**
 * Per-version dependency index — a flattened projection of
 * `package_versions.manifest.dependencies`.
 *
 * AFPS §4.1 makes dependency values polymorphic: each entry is EITHER a
 * bare semver range string OR an object `{ version, scopes?, auth_key?, ... }`
 * carrying per-dependency configuration. The canonical, lossless form lives
 * on `package_versions.manifest`; this table stores ONLY the flattened
 * `(dep_scope, dep_name, dep_type, version_range)` tuple so the resolver,
 * dist-tag retargeter, and registry search can use plain SQL joins / indexes
 * instead of walking the JSONB blob.
 *
 * Treat this table as a derived index: when adding a new polymorphic field
 * (e.g. AFPS picks up new per-dep config), update the manifest schema first,
 * then decide whether the new field deserves a column here. The flattener
 * lives in `@appstrate/core/dependencies.storeVersionDependencies`.
 */
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
    /** Flattened semver range string. Canonical polymorphic form lives on `package_versions.manifest`. */
    versionRange: text("version_range").notNull(),
  },
  (table) => [
    uniqueIndex("pkg_ver_deps_unique").on(
      table.versionId,
      table.depScope,
      table.depName,
      table.depType,
    ),
  ],
);
