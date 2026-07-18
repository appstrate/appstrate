// SPDX-License-Identifier: Apache-2.0

import { eq, and, or, desc, sql, isNotNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, packages } from "@appstrate/db/schema";
import type { Package } from "@appstrate/db/schema";
import { extractDependencies } from "@appstrate/core/dependencies";
import { buildPackageId } from "@appstrate/core/naming";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";
import { type PackageTypeConfig } from "./config.ts";
import { deletePackageFiles } from "./storage.ts";
import { asRecord } from "@appstrate/core/safe-json";
import {
  orgOrSystemFilter,
  getPackageDisplayName,
  notEphemeralFilter,
} from "../../lib/package-helpers.ts";
import { isUnlisted } from "../../lib/package-visibility.ts";
import { parseDraftManifest } from "../../lib/manifest-utils.ts";
import { toISORequired } from "../../lib/date-helpers.ts";
import { scopedWhere } from "../../lib/db-helpers.ts";

export class PackageAlreadyExistsError extends Error {
  constructor(
    public packageId: string,
    public packageType: string,
  ) {
    super(`A ${packageType} with identifier '${packageId}' already exists`);
    this.name = "PackageAlreadyExistsError";
  }
}

// ─────────────────────────────────────────────
// Generic package lookup
// ─────────────────────────────────────────────

/** Get a raw package row by ID (no org filter — used for import collision checks). */
export async function getPackageById(id: string): Promise<Package | null> {
  const rows = await db.select().from(packages).where(eq(packages.id, id)).limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────
// Helpers (private)
// ─────────────────────────────────────────────

/** Fetch package display names from a list of package IDs. */
/** Find packages that depend on the target package (via manifest dependencies). */
async function findDependentPackages(
  orgId: string,
  targetPackageId: string,
): Promise<{ id: string; display_name: string }[]> {
  const orgPkgs = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(and(scopedWhere(packages, { orgId }), notEphemeralFilter()));

  const dependents: { id: string; display_name: string }[] = [];
  for (const pkg of orgPkgs) {
    if (!pkg.draftManifest || pkg.id === targetPackageId) continue;
    const m = parseDraftManifest(pkg.draftManifest);
    const deps = extractDependencies(m);
    for (const dep of deps) {
      if (buildPackageId(dep.depScope, dep.depName) === targetPackageId) {
        dependents.push({ id: pkg.id, display_name: getPackageDisplayName(pkg) });
        break;
      }
    }
  }
  return dependents;
}

// ─────────────────────────────────────────────
// Create / Update with optimistic locking
// ─────────────────────────────────────────────

export interface CreateItemInput {
  id: string;
  name?: string;
  description?: string;
  content: string;
  createdBy?: string;
}

/** Insert a new package item. `item.id` must be the fully-scoped packageId (e.g. `@scope/name`). */
export async function createOrgItem(
  orgId: string,
  item: CreateItemInput,
  cfg: PackageTypeConfig,
  manifest?: Record<string, unknown>,
  forkedFrom?: string,
): Promise<Package> {
  const now = new Date();
  const packageId = item.id;

  const finalManifest: Record<string, unknown> = manifest
    ? { ...manifest }
    : { version: "1.0.0", name: packageId };

  finalManifest.$schema = AFPS_SCHEMA_URLS[cfg.type];
  finalManifest.type = cfg.type;
  if (!finalManifest.name) finalManifest.name = packageId;
  if (item.name) finalManifest.display_name = item.name;
  if (item.description) finalManifest.description = item.description;

  try {
    const [row] = await db
      .insert(packages)
      .values({
        id: packageId,
        orgId,
        type: cfg.type,
        source: "local",
        draftManifest: finalManifest,
        draftContent: item.content,
        createdBy: item.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
        forkedFrom: forkedFrom ?? null,
      })
      .returning();

    if (!row) throw new Error("Failed to insert package: no row returned");
    return row;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as { code: string }).code === "23505") {
      // Look up the existing package's type for a helpful error message
      const [existing] = await db
        .select({ type: packages.type })
        .from(packages)
        .where(eq(packages.id, packageId))
        .limit(1);
      throw new PackageAlreadyExistsError(packageId, existing?.type ?? cfg.type);
    }
    throw err;
  }
}

/** Update a package item with optimistic locking. Returns null on version mismatch (409). */
export async function updateOrgItem(
  orgId: string,
  id: string,
  payload: {
    manifest: Record<string, unknown>;
    content: string;
  },
  expectedVersion: number,
): Promise<Package | null> {
  const rows = await db
    .update(packages)
    .set({
      draftManifest: payload.manifest,
      draftContent: payload.content,
      updatedAt: new Date(),
      lockVersion: sql`${packages.lockVersion} + 1`,
    })
    .where(
      scopedWhere(packages, {
        orgId,
        extra: [eq(packages.id, id), eq(packages.lockVersion, expectedVersion)],
      }),
    )
    .returning();

  return rows[0] ?? null;
}

/**
 * Re-install (overwrite) an existing item's draft manifest + content.
 *
 * Distinct from {@link updateOrgItem}, which is optimistic (returns null so the
 * route surfaces a 409) for USER-facing edits where a stale `lock_version`
 * means "someone else edited, reload". A re-install is machine-driven
 * (post-install / bundle import) and last-writer-wins: it re-reads the CURRENT
 * `lock_version` and retries the update when a concurrent write bumped it, so
 * the install is never silently dropped on a lock mismatch (the previous
 * caller passed a lock_version read moments earlier and ignored the null
 * return — a concurrent edit would make the re-install a no-op). Returns the
 * updated row, or null when the item no longer exists (caller should insert).
 */
export async function reinstallOrgItem(
  orgId: string,
  id: string,
  payload: {
    manifest: Record<string, unknown>;
    content: string;
  },
): Promise<Package | null> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [current] = await db
      .select({ lockVersion: packages.lockVersion })
      .from(packages)
      .where(scopedWhere(packages, { orgId, extra: [eq(packages.id, id)] }))
      .limit(1);
    if (!current) return null;

    const updated = await updateOrgItem(orgId, id, payload, current.lockVersion);
    if (updated) return updated;
    // Lost the optimistic-lock race (a concurrent write bumped lock_version) —
    // re-read the fresh version and retry the overwrite.
  }
  throw new Error(
    `reinstallOrgItem: exceeded retry budget for '${id}' under concurrent modification`,
  );
}

/** List items of a type accessible to an application (system + installed). */
export async function listOrgItems(
  orgId: string,
  cfg: PackageTypeConfig,
  applicationId: string,
  opts?: { activeOnly?: boolean },
) {
  // Default: catalogue view — system packages (always visible) + org packages
  // installed in this app. `activeOnly` narrows to packages that are actually
  // active in THIS app: an enabled `application_packages` row, dropping the
  // "system always shows" branch. Used by the agent editor's integration
  // picker so it only offers usable integrations (server-side filter — the
  // full catalogue can be large).
  const installFilter = opts?.activeOnly
    ? and(isNotNull(applicationPackages.packageId), eq(applicationPackages.enabled, true))
    : or(eq(packages.source, "system"), isNotNull(applicationPackages.packageId));
  const data = await db
    .select({
      id: packages.id,
      orgId: packages.orgId,
      type: packages.type,
      source: packages.source,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      createdBy: packages.createdBy,
      createdAt: packages.createdAt,
      updatedAt: packages.updatedAt,
      autoInstalled: packages.autoInstalled,
      forkedFrom: packages.forkedFrom,
      lockVersion: packages.lockVersion,
    })
    .from(packages)
    .leftJoin(
      applicationPackages,
      and(
        eq(applicationPackages.packageId, packages.id),
        eq(applicationPackages.applicationId, applicationId),
      ),
    )
    .where(
      and(
        orgOrSystemFilter(orgId),
        eq(packages.type, cfg.type),
        notEphemeralFilter(),
        installFilter,
      ),
    )
    .orderBy(
      sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`,
      desc(packages.createdAt),
    );

  // Count usage by scanning all org packages' manifests. Ephemeral shadow
  // packages are transient and never referenced by other packages, so
  // filtering them out also skips their (empty) dependencies.
  const countMap = new Map<string, number>();
  const allOrgPkgs = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(and(scopedWhere(packages, { orgId }), notEphemeralFilter()));
  for (const pkg of allOrgPkgs) {
    if (!pkg.draftManifest) continue;
    const deps = extractDependencies(parseDraftManifest(pkg.draftManifest));
    for (const dep of deps) {
      const depId = buildPackageId(dep.depScope, dep.depName);
      countMap.set(depId, (countMap.get(depId) ?? 0) + 1);
    }
  }

  // Unlisted packages (`_meta["dev.appstrate/visibility"]`) never appear in
  // list responses — they stay resolvable by exact id via `getOrgItem`.
  const listed = data.filter((row) => !isUnlisted(asRecord(row.draftManifest)));

  return listed.map((row) => {
    const m = parseDraftManifest(row.draftManifest);
    return {
      id: row.id,
      orgId: row.orgId,
      name: getPackageDisplayName(row),
      description: m.description ?? null,
      source: row.source ?? "local",
      created_by: row.createdBy,
      createdAt: toISORequired(row.createdAt),
      updatedAt: toISORequired(row.updatedAt),
      used_by_agents: countMap.get(row.id) ?? 0,
      version: typeof m.version === "string" ? m.version : null,
      auto_installed: row.autoInstalled,
      forked_from: row.forkedFrom ?? null,
    };
  });
}

/** Get a single item with content and list of agents referencing it. */
export async function getOrgItem(orgId: string, itemId: string, cfg: PackageTypeConfig) {
  const orgFilter = orgOrSystemFilter(orgId);

  const [data] = await db
    .select()
    .from(packages)
    .where(
      and(orgFilter, eq(packages.id, itemId), eq(packages.type, cfg.type), notEphemeralFilter()),
    )
    .limit(1);

  if (!data) return null;

  const dependents = await findDependentPackages(orgId, itemId);

  const m = parseDraftManifest(data.draftManifest);
  return {
    id: data.id,
    orgId: data.orgId,
    name: getPackageDisplayName(data),
    description: m.description ?? null,
    content: data.draftContent,
    source: data.source ?? "local",
    created_by: data.createdBy,
    createdAt: toISORequired(data.createdAt),
    updatedAt: toISORequired(data.updatedAt),
    auto_installed: data.autoInstalled,
    version: typeof m.version === "string" ? m.version : null,
    manifest_name: typeof m.name === "string" ? m.name : null,
    manifest: asRecord(data.draftManifest),
    lock_version: data.lockVersion,
    forked_from: data.forkedFrom ?? null,
    agents: dependents,
  };
}

/** Delete an item. Returns error info if still referenced by other packages. */
export async function deleteOrgItem(
  orgId: string,
  itemId: string,
  cfg: PackageTypeConfig,
): Promise<{
  ok: boolean;
  error?: string;
  dependents?: { id: string; display_name: string }[];
}> {
  const dependents = await findDependentPackages(orgId, itemId);
  if (dependents.length > 0) {
    return { ok: false, error: "IN_USE", dependents };
  }

  // Scope delete to non-ephemeral rows only: deleting a shadow package
  // here would cascade-wipe its runs history.
  await db.delete(packages).where(
    scopedWhere(packages, {
      orgId,
      extra: [eq(packages.id, itemId), eq(packages.type, cfg.type), notEphemeralFilter()],
    }),
  );

  await deletePackageFiles(cfg.storageFolder, orgId, itemId);

  return { ok: true };
}
