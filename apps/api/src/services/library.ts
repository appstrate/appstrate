import { zipArtifact, unzipArtifact } from "@appstrate/validation/zip";
import { extractSkillMeta } from "@appstrate/validation";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import * as storage from "@appstrate/db/storage";
import { logger } from "../lib/logger.ts";
import {
  getBuiltInSkills,
  getBuiltInExtensions,
  isBuiltInSkill,
  isBuiltInExtension,
} from "./builtin-library.ts";
import { createVersionAndUpload } from "./package-versions.ts";

// ─────────────────────────────────────────────
// Library type configuration
// ─────────────────────────────────────────────

interface BuiltInItem {
  id: string;
  name: string;
  description: string;
  content: string;
}

interface LibraryTypeConfig {
  type: "skill" | "extension";
  storageFolder: "skills" | "extensions";
  getBuiltIns: () => ReadonlyMap<string, BuiltInItem>;
  isBuiltIn: (id: string) => boolean;
  label: string;
}

const SKILL_CONFIG: LibraryTypeConfig = {
  type: "skill",
  storageFolder: "skills",
  getBuiltIns: getBuiltInSkills,
  isBuiltIn: isBuiltInSkill,
  label: "Skills",
};

const EXTENSION_CONFIG: LibraryTypeConfig = {
  type: "extension",
  storageFolder: "extensions",
  getBuiltIns: getBuiltInExtensions,
  isBuiltIn: isBuiltInExtension,
  label: "Extensions",
};

export function getLibraryConfig(type: "skill" | "extension"): LibraryTypeConfig {
  return type === "skill" ? SKILL_CONFIG : EXTENSION_CONFIG;
}

// ─────────────────────────────────────────────
// Library storage
// ─────────────────────────────────────────────

const LIBRARY_BUCKET = "library-packages";

/** Ensure the library-packages Storage bucket exists. Call once at boot. */
export const ensureLibraryBucket = () => storage.ensureBucket(LIBRARY_BUCKET);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Count built-in skill/extension usage from flow manifests (since built-in IDs can't be in junction tables). */
async function countBuiltInUsageFromManifests(
  orgId: string,
  cfg: LibraryTypeConfig,
): Promise<Map<string, number>> {
  const flowRows = await db
    .select({ manifest: packages.manifest })
    .from(packages)
    .where(and(eq(packages.orgId, orgId), eq(packages.type, "flow")));

  const countMap = new Map<string, number>();

  for (const flow of flowRows) {
    const manifest = flow.manifest as { requires?: { [k: string]: { id: string }[] } };
    const items = manifest?.requires?.[cfg.storageFolder] ?? [];
    for (const item of items) {
      if (cfg.isBuiltIn(item.id)) {
        countMap.set(item.id, (countMap.get(item.id) ?? 0) + 1);
      }
    }
  }
  return countMap;
}

/** Fetch package display names from a list of package IDs. */
async function getPackageDisplayNames(
  packageIds: string[],
): Promise<{ id: string; displayName: string }[]> {
  if (packageIds.length === 0) return [];
  const rows = await db
    .select({ id: packages.id, displayName: packages.displayName })
    .from(packages)
    .where(inArray(packages.id, packageIds));

  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName ?? r.id,
  }));
}

// ─────────────────────────────────────────────
// Unified CRUD functions (private)
// ─────────────────────────────────────────────

interface UpsertItemInput {
  id: string;
  name?: string;
  description?: string;
  content: string;
  createdBy?: string;
}

/** List all items of a type in the org with usedByFlows count (built-in + org). */
async function listOrgItems(orgId: string, cfg: LibraryTypeConfig) {
  const data = await db
    .select()
    .from(packages)
    .where(and(eq(packages.orgId, orgId), eq(packages.type, cfg.type)))
    .orderBy(desc(packages.createdAt));

  const depRows = await db
    .select({ dependencyId: packageDependencies.dependencyId })
    .from(packageDependencies)
    .where(eq(packageDependencies.orgId, orgId));

  const countMap = new Map<string, number>();
  for (const row of depRows) {
    countMap.set(row.dependencyId, (countMap.get(row.dependencyId) ?? 0) + 1);
  }

  const builtInCounts = await countBuiltInUsageFromManifests(orgId, cfg);

  const orgItemIds = new Set(data.map((row) => row.id));

  const builtInItems = [...cfg.getBuiltIns().values()]
    .filter((item) => !orgItemIds.has(item.id))
    .map((item) => ({
      id: item.id,
      orgId: null as string | null,
      name: item.name,
      description: item.description,
      source: "built-in" as const,
      createdBy: null as string | null,
      createdAt: "",
      updatedAt: "",
      usedByFlows: builtInCounts.get(item.id) ?? 0,
    }));

  const orgItems = data.map((row) => ({
    id: row.id,
    orgId: row.orgId,
    name: row.displayName ?? row.name,
    description: row.description,
    source: "local" as const,
    createdBy: row.createdBy,
    createdAt: row.createdAt?.toISOString() ?? "",
    updatedAt: row.updatedAt?.toISOString() ?? "",
    usedByFlows: countMap.get(row.id) ?? 0,
  }));

  return [...builtInItems, ...orgItems];
}

/** Get a single item with content and list of flows referencing it. */
async function getOrgItem(orgId: string, itemId: string, cfg: LibraryTypeConfig) {
  const builtIn = cfg.getBuiltIns().get(itemId);
  if (builtIn) {
    return {
      id: builtIn.id,
      orgId: null as string | null,
      name: builtIn.name,
      description: builtIn.description,
      content: builtIn.content,
      source: "built-in" as const,
      createdBy: null as string | null,
      createdAt: "",
      updatedAt: "",
      flows: [],
    };
  }

  const [data] = await db
    .select()
    .from(packages)
    .where(and(eq(packages.orgId, orgId), eq(packages.id, itemId), eq(packages.type, cfg.type)))
    .limit(1);

  if (!data) return null;

  const depRefs = await db
    .select({ packageId: packageDependencies.packageId })
    .from(packageDependencies)
    .where(and(eq(packageDependencies.orgId, orgId), eq(packageDependencies.dependencyId, itemId)));

  const packageIds = depRefs.map((d) => d.packageId);

  return {
    id: data.id,
    orgId: data.orgId,
    name: data.displayName ?? data.name,
    description: data.description,
    content: data.content,
    source: "local" as const,
    createdBy: data.createdBy,
    createdAt: data.createdAt?.toISOString() ?? "",
    updatedAt: data.updatedAt?.toISOString() ?? "",
    flows: await getPackageDisplayNames(packageIds),
  };
}

/** Insert or update an item in the org library. */
async function upsertOrgItem(orgId: string, item: UpsertItemInput, cfg: LibraryTypeConfig) {
  const now = new Date();

  const [data] = await db
    .insert(packages)
    .values({
      id: item.id,
      orgId,
      type: cfg.type,
      source: "local",
      name: item.id,
      displayName: item.name ?? null,
      description: item.description ?? null,
      content: item.content,
      createdBy: item.createdBy ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [packages.id],
      set: {
        displayName: item.name ?? null,
        description: item.description ?? null,
        content: item.content,
        createdBy: item.createdBy ?? null,
        updatedAt: now,
      },
      setWhere: eq(packages.orgId, sql`excluded.org_id`),
    })
    .returning();

  return data!;
}

/** Delete an item. Returns error info if still referenced by flows. */
async function deleteOrgItem(
  orgId: string,
  itemId: string,
  cfg: LibraryTypeConfig,
): Promise<{ ok: boolean; error?: string; flows?: { id: string; displayName: string }[] }> {
  const refs = await db
    .select({ packageId: packageDependencies.packageId })
    .from(packageDependencies)
    .where(and(eq(packageDependencies.orgId, orgId), eq(packageDependencies.dependencyId, itemId)));

  if (refs.length > 0) {
    const flowList = await getPackageDisplayNames(refs.map((r) => r.packageId));
    return { ok: false, error: "IN_USE", flows: flowList };
  }

  await db
    .delete(packages)
    .where(and(eq(packages.orgId, orgId), eq(packages.id, itemId), eq(packages.type, cfg.type)));

  await deleteLibraryPackage(cfg.storageFolder, orgId, itemId);

  return { ok: true };
}

/** Replace all references of a type for a flow. Only org IDs are stored (built-in tracked via manifest). */
async function setFlowItems(
  packageId: string,
  orgId: string,
  itemIds: string[],
  cfg: LibraryTypeConfig,
): Promise<void> {
  const orgItemIds = itemIds.filter((id) => !cfg.isBuiltIn(id));

  // Validate existence outside transaction (read-only)
  if (orgItemIds.length > 0) {
    const existing = await db
      .select({ id: packages.id })
      .from(packages)
      .where(
        and(
          eq(packages.orgId, orgId),
          eq(packages.type, cfg.type),
          inArray(packages.id, orgItemIds),
        ),
      );

    const existingIds = new Set(existing.map((e) => e.id));
    const missing = orgItemIds.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      throw new Error(`${cfg.label} introuvables dans la bibliotheque: ${missing.join(", ")}`);
    }
  }

  // Delete + insert in a single transaction for atomicity
  await db.transaction(async (tx) => {
    const existingDeps = await tx
      .select({ dependencyId: packageDependencies.dependencyId })
      .from(packageDependencies)
      .innerJoin(packages, eq(packages.id, packageDependencies.dependencyId))
      .where(
        and(
          eq(packageDependencies.packageId, packageId),
          eq(packageDependencies.orgId, orgId),
          eq(packages.type, cfg.type),
        ),
      );

    const existingDepIds = existingDeps.map((d) => d.dependencyId);
    if (existingDepIds.length > 0) {
      await tx
        .delete(packageDependencies)
        .where(
          and(
            eq(packageDependencies.packageId, packageId),
            eq(packageDependencies.orgId, orgId),
            inArray(packageDependencies.dependencyId, existingDepIds),
          ),
        );
    }

    if (orgItemIds.length === 0) return;

    const rows = orgItemIds.map((depId) => ({
      packageId,
      dependencyId: depId,
      orgId,
    }));

    await tx.insert(packageDependencies).values(rows);
  });
}

/** Get all files for a flow's referenced items of a type. Returns Map<itemId, files>. */
async function getFlowItemFiles(
  packageId: string,
  orgId: string,
  cfg: LibraryTypeConfig,
): Promise<Map<string, Record<string, Uint8Array>>> {
  const data = await db
    .select({ dependencyId: packageDependencies.dependencyId })
    .from(packageDependencies)
    .innerJoin(packages, eq(packages.id, packageDependencies.dependencyId))
    .where(
      and(
        eq(packageDependencies.packageId, packageId),
        eq(packageDependencies.orgId, orgId),
        eq(packages.type, cfg.type),
      ),
    );

  const entries = await Promise.all(
    data.map(async (row) => {
      const files = await downloadLibraryPackage(cfg.storageFolder, orgId, row.dependencyId);
      return [row.dependencyId, files] as const;
    }),
  );

  const result = new Map<string, Record<string, Uint8Array>>();
  for (const [id, files] of entries) {
    if (files) result.set(id, files);
  }
  return result;
}

// ─────────────────────────────────────────────
// Exported wrappers (preserve existing API surface)
// ─────────────────────────────────────────────

export const listOrgSkills = (orgId: string) => listOrgItems(orgId, SKILL_CONFIG);
export const listOrgExtensions = (orgId: string) => listOrgItems(orgId, EXTENSION_CONFIG);

export const getOrgSkill = (orgId: string, id: string) => getOrgItem(orgId, id, SKILL_CONFIG);
export const getOrgExtension = (orgId: string, id: string) =>
  getOrgItem(orgId, id, EXTENSION_CONFIG);

export const upsertOrgSkill = (orgId: string, item: UpsertItemInput) =>
  upsertOrgItem(orgId, item, SKILL_CONFIG);
export const upsertOrgExtension = (orgId: string, item: UpsertItemInput) =>
  upsertOrgItem(orgId, item, EXTENSION_CONFIG);

export const deleteOrgSkill = (orgId: string, id: string) => deleteOrgItem(orgId, id, SKILL_CONFIG);
export const deleteOrgExtension = (orgId: string, id: string) =>
  deleteOrgItem(orgId, id, EXTENSION_CONFIG);

export const setFlowSkills = (pkgId: string, orgId: string, ids: string[]) =>
  setFlowItems(pkgId, orgId, ids, SKILL_CONFIG);
export const setFlowExtensions = (pkgId: string, orgId: string, ids: string[]) =>
  setFlowItems(pkgId, orgId, ids, EXTENSION_CONFIG);

export const getFlowSkillFiles = (pkgId: string, orgId: string) =>
  getFlowItemFiles(pkgId, orgId, SKILL_CONFIG);
export const getFlowExtensionFiles = (pkgId: string, orgId: string) =>
  getFlowItemFiles(pkgId, orgId, EXTENSION_CONFIG);

// ─────────────────────────────────────────────
// Library package Storage (full ZIP)
// ─────────────────────────────────────────────

/** Upload a library item's full normalized files to Storage. */
export async function uploadLibraryPackage(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
  normalizedFiles: Record<string, Uint8Array>,
): Promise<void> {
  const zip = zipArtifact(normalizedFiles, 6);
  const path = `${orgId}/${type}/${itemId}.zip`;
  try {
    await storage.uploadFile(LIBRARY_BUCKET, path, zip);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to upload library package", { type, orgId, itemId, error: message });
    throw err;
  }
}

/** Download a library item's full files from Storage. Returns normalized file map or null. */
async function downloadLibraryPackage(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
): Promise<Record<string, Uint8Array> | null> {
  const path = `${orgId}/${type}/${itemId}.zip`;
  const data = await storage.downloadFile(LIBRARY_BUCKET, path);
  if (!data) {
    logger.warn("Failed to download library package", { type, orgId, itemId });
    return null;
  }
  return unzipArtifact(new Uint8Array(data)).files;
}

/** Delete a library item's package from Storage. */
async function deleteLibraryPackage(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
): Promise<void> {
  const path = `${orgId}/${type}/${itemId}.zip`;
  await storage.deleteFile(LIBRARY_BUCKET, path);
}

// ─────────────────────────────────────────────
// Post-install — shared per-type side-effects
// ─────────────────────────────────────────────

/**
 * Run per-type post-install side-effects after a package is saved to the DB.
 * Handles version creation (flow), skill upsert + storage, extension upsert + storage.
 */
export async function postInstallPackage(params: {
  packageType: "flow" | "skill" | "extension";
  packageId: string;
  orgId: string;
  userId: string;
  content: string;
  files: Record<string, Uint8Array>;
  zipBuffer: Buffer;
}): Promise<void> {
  const { packageType, packageId, orgId, userId, content, files, zipBuffer } = params;

  switch (packageType) {
    case "flow": {
      try {
        await createVersionAndUpload(packageId, userId, zipBuffer);
      } catch (err) {
        logger.error("Failed to create version for flow", {
          packageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }
    case "skill": {
      const skillMeta = extractSkillMeta(content);
      await upsertOrgItem(
        orgId,
        {
          id: packageId,
          name: skillMeta.name || undefined,
          description: skillMeta.description || undefined,
          content,
          createdBy: userId,
        },
        SKILL_CONFIG,
      );
      await uploadLibraryPackage("skills", orgId, packageId, files);
      break;
    }
    case "extension": {
      await upsertOrgItem(orgId, { id: packageId, content, createdBy: userId }, EXTENSION_CONFIG);
      await uploadLibraryPackage("extensions", orgId, packageId, files);
      break;
    }
  }
}
