// SPDX-License-Identifier: Apache-2.0

import { eq, and, or, ne, desc, sql, isNotNull } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import { applicationPackages, packages } from "@appstrate/db/schema";
import type { Package } from "@appstrate/db/schema";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";
import { type PackageTypeConfig } from "./config.ts";
import { enqueueStorageDeletion } from "../storage-deletion.ts";
import { packageStorageDeletionJobs } from "../package-storage-deletion.ts";
import { asRecord } from "@appstrate/core/safe-json";
import {
  orgOrSystemFilter,
  getPackageDisplayName,
  notEphemeralFilter,
} from "../../lib/package-helpers.ts";
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

/**
 * The three AFPS §4.1 dependency maps on a manifest. Compile-time constants —
 * they are interpolated as SQL literals below, never user input.
 */
const DEPENDENCY_MAPS = ["skills", "mcp_servers", "integrations"] as const;
type DependencyMap = (typeof DEPENDENCY_MAPS)[number];

/**
 * SQL for one dependency map of `packages.draft_manifest`, normalized to an
 * empty object when it is absent or not an object. Both `jsonb_object_keys`
 * and `jsonb_exists` reject non-object input, and a hand-edited manifest whose
 * `dependencies.skills` is a string must not take down the catalog read.
 */
function dependencyMapSql(map: DependencyMap) {
  const expr = sql`${packages.draftManifest} -> 'dependencies' -> ${map}::text`;
  return sql`(case when jsonb_typeof(${expr}) = 'object' then ${expr} else '{}'::jsonb end)`;
}

/** SQL mirroring {@link getPackageDisplayName}: manifest `display_name` when it is a string, else the id. */
const displayNameSql = sql<string>`(case
  when jsonb_typeof(${packages.draftManifest} -> 'display_name') = 'string'
  then ${packages.draftManifest} ->> 'display_name'
  else ${packages.id}
end)`;

/**
 * Find packages that depend on the target package (via manifest dependencies).
 *
 * Evaluated in SQL: the previous implementation pulled EVERY org package's
 * `draft_manifest` jsonb into the process to answer a boolean question, on
 * both the item-detail read and the delete pre-check.
 */
async function findDependentPackages(
  orgId: string,
  targetPackageId: string,
): Promise<{ id: string; display_name: string }[]> {
  const declaresTarget = or(
    ...DEPENDENCY_MAPS.map(
      (map) => sql`jsonb_exists(${dependencyMapSql(map)}, ${targetPackageId})`,
    ),
  )!;

  return db
    .select({ id: packages.id, display_name: displayNameSql })
    .from(packages)
    .where(
      and(
        scopedWhere(packages, { orgId }),
        notEphemeralFilter(),
        ne(packages.id, targetPackageId),
        declaresTarget,
      ),
    )
    .orderBy(packages.id);
}

/**
 * `used_by_agents` for every package of the org, computed in SQL.
 *
 * One row per declared dependency edge (a short package id string) instead of
 * one full `draft_manifest` jsonb per org package — the counting loop only
 * ever needed the KEYS of the three dependency maps. Semantics are preserved
 * edge-for-edge, including a package that declares the same id under two maps
 * counting twice, and a package counting itself.
 *
 * The one behavioral difference is a strict improvement: a malformed manifest
 * (invalid scoped name, non-string version range) used to make
 * `extractDependencies` throw and 500 the whole catalog read. Here such a key
 * is simply counted under an id no package can have, so it matches nothing.
 */
async function countDependencyEdges(orgId: string): Promise<Map<string, number>> {
  const branches = DEPENDENCY_MAPS.map((map) =>
    db
      .select({
        depId: sql<string>`jsonb_object_keys(${dependencyMapSql(map)})`.as("dep_id"),
      })
      .from(packages)
      // Ephemeral shadow packages are transient and never referenced by other
      // packages, so filtering them out also skips their (empty) dependencies.
      .where(and(scopedWhere(packages, { orgId }), notEphemeralFilter())),
  );

  const rows = await unionAll(branches[0]!, branches[1]!, ...branches.slice(2));

  const countMap = new Map<string, number>();
  for (const row of rows) {
    countMap.set(row.depId, (countMap.get(row.depId) ?? 0) + 1);
  }
  return countMap;
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
  // `draftContent` (the whole SKILL.md / prompt.md body) is deliberately NOT
  // projected: the list mapper never reads it, and it is by far the largest
  // column on the row.
  const dataQuery = db
    .select({
      id: packages.id,
      orgId: packages.orgId,
      type: packages.type,
      source: packages.source,
      draftManifest: packages.draftManifest,
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

  // The catalog page and the usage counts are independent reads over the same
  // tenant — issued concurrently rather than one after the other.
  const [data, countMap] = await Promise.all([dataQuery, countDependencyEdges(orgId)]);

  return data.map((row) => {
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

  await db.transaction(async (tx) => {
    // Enumerate BEFORE the delete: `ON DELETE CASCADE` on `package_versions`
    // makes every published artifact's key unrecoverable the moment the
    // `packages` row goes. This previously ran as a bare delete followed by a
    // best-effort `deletePackageFiles`, which removed only the
    // `library-packages` object and orphaned every `agent-packages` version ZIP
    // of the item outright — a permanent leak on an ordinary user action.
    const jobs = await packageStorageDeletionJobs(tx, orgId, itemId, "package_deleted");

    // Scope delete to non-ephemeral rows only: deleting a shadow package
    // here would cascade-wipe its runs history.
    const deleted = await tx
      .delete(packages)
      .where(
        scopedWhere(packages, {
          orgId,
          extra: [eq(packages.id, itemId), eq(packages.type, cfg.type), notEphemeralFilter()],
        }),
      )
      .returning({ id: packages.id });

    // Enqueue ONLY when the row actually went. The enumeration matches on
    // (org, id) while the delete additionally filters on type and
    // non-ephemeral, so a type mismatch would otherwise queue the deletion of
    // an object whose row is still live.
    if (deleted.length > 0) await enqueueStorageDeletion(tx, jobs);
  });

  return { ok: true };
}
