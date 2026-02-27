import { zipSync, unzipSync } from "fflate";
import { eq, and, inArray, desc } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { orgSkills, orgExtensions, flowSkills, flowExtensions, flows } from "@appstrate/db/schema";
import * as storage from "@appstrate/db/storage";
import { logger } from "../lib/logger.ts";
import {
  getBuiltInSkills,
  getBuiltInExtensions,
  isBuiltInSkill,
  isBuiltInExtension,
} from "./builtin-library.ts";

const LIBRARY_BUCKET = "library-packages";

/** Ensure the library-packages Storage bucket exists. Call once at boot. */
export const ensureLibraryBucket = () => storage.ensureBucket(LIBRARY_BUCKET);

/** Count built-in skill/extension usage from flow manifests (since built-in IDs can't be in junction tables). */
async function countBuiltInUsageFromManifests(
  orgId: string,
  field: "skills" | "extensions",
): Promise<Map<string, number>> {
  const flowRows = await db
    .select({ manifest: flows.manifest })
    .from(flows)
    .where(eq(flows.orgId, orgId));

  const countMap = new Map<string, number>();
  const isBuiltIn = field === "skills" ? isBuiltInSkill : isBuiltInExtension;

  for (const flow of flowRows) {
    const manifest = flow.manifest as { requires?: { [k: string]: { id: string }[] } };
    const items = manifest?.requires?.[field] ?? [];
    for (const item of items) {
      if (isBuiltIn(item.id)) {
        countMap.set(item.id, (countMap.get(item.id) ?? 0) + 1);
      }
    }
  }
  return countMap;
}

// --- Helpers ---

/** Fetch flow display names from a list of flow IDs. */
async function getFlowDisplayNames(
  flowIds: string[],
): Promise<{ id: string; displayName: string }[]> {
  if (flowIds.length === 0) return [];
  const flowRows = await db
    .select({ id: flows.id, manifest: flows.manifest })
    .from(flows)
    .where(inArray(flows.id, flowIds));

  return flowRows.map((f) => ({
    id: f.id,
    displayName:
      (f.manifest as { metadata?: { displayName?: string } })?.metadata?.displayName ?? f.id,
  }));
}

// --- Skills ---

/** List all skills in the org with usedByFlows count (built-in + org). */
export async function listOrgSkills(orgId: string) {
  const data = await db
    .select()
    .from(orgSkills)
    .where(eq(orgSkills.orgId, orgId))
    .orderBy(desc(orgSkills.createdAt));

  // Count org skills from junction table
  const flowSkillRows = await db
    .select({ skillId: flowSkills.skillId })
    .from(flowSkills)
    .where(eq(flowSkills.orgId, orgId));

  const countMap = new Map<string, number>();
  for (const row of flowSkillRows) {
    countMap.set(row.skillId, (countMap.get(row.skillId) ?? 0) + 1);
  }

  // Count built-in skills from flow manifests (they can't be in the junction table due to FK)
  const builtInCounts = await countBuiltInUsageFromManifests(orgId, "skills");

  const orgSkillIds = new Set(data.map((row) => row.id));

  // Built-in skills first
  const builtInItems = [...getBuiltInSkills().values()]
    .filter((s) => !orgSkillIds.has(s.id))
    .map((s) => ({
      id: s.id,
      orgId: null as string | null,
      name: s.name,
      description: s.description,
      source: "built-in" as const,
      createdBy: null as string | null,
      createdAt: "",
      updatedAt: "",
      usedByFlows: builtInCounts.get(s.id) ?? 0,
    }));

  const orgItems = data.map((row) => ({
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    description: row.description,
    source: "user" as const,
    createdBy: row.createdBy,
    createdAt: row.createdAt?.toISOString() ?? "",
    updatedAt: row.updatedAt?.toISOString() ?? "",
    usedByFlows: countMap.get(row.id) ?? 0,
  }));

  return [...builtInItems, ...orgItems];
}

/** Get a single skill with content and list of flows referencing it. */
export async function getOrgSkill(orgId: string, skillId: string) {
  // Check built-in skills first
  const builtIn = getBuiltInSkills().get(skillId);
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
    .from(orgSkills)
    .where(and(eq(orgSkills.orgId, orgId), eq(orgSkills.id, skillId)))
    .limit(1);

  if (!data) return null;

  // Fetch flow references from junction table
  const flowSkillRefs = await db
    .select({ flowId: flowSkills.flowId })
    .from(flowSkills)
    .where(and(eq(flowSkills.orgId, orgId), eq(flowSkills.skillId, skillId)));

  const flowIds = flowSkillRefs.map((fs) => fs.flowId);

  return {
    id: data.id,
    orgId: data.orgId,
    name: data.name,
    description: data.description,
    content: data.content,
    source: "user" as const,
    createdBy: data.createdBy,
    createdAt: data.createdAt?.toISOString() ?? "",
    updatedAt: data.updatedAt?.toISOString() ?? "",
    flows: await getFlowDisplayNames(flowIds),
  };
}

/** Insert or update a skill in the org library. */
export async function upsertOrgSkill(
  orgId: string,
  skill: {
    id: string;
    name?: string;
    description?: string;
    content: string;
    createdBy?: string;
  },
) {
  const now = new Date();

  const [data] = await db
    .insert(orgSkills)
    .values({
      id: skill.id,
      orgId,
      name: skill.name ?? null,
      description: skill.description ?? null,
      content: skill.content,
      createdBy: skill.createdBy ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [orgSkills.orgId, orgSkills.id],
      set: {
        name: skill.name ?? null,
        description: skill.description ?? null,
        content: skill.content,
        createdBy: skill.createdBy ?? null,
        updatedAt: now,
      },
    })
    .returning();

  return data!;
}

/** Delete a skill. Returns error info if still referenced by flows. */
export async function deleteOrgSkill(
  orgId: string,
  skillId: string,
): Promise<{ ok: boolean; error?: string; flows?: { id: string; displayName: string }[] }> {
  const refs = await db
    .select({ flowId: flowSkills.flowId })
    .from(flowSkills)
    .where(and(eq(flowSkills.orgId, orgId), eq(flowSkills.skillId, skillId)));

  if (refs.length > 0) {
    const flowList = await getFlowDisplayNames(refs.map((r) => r.flowId));
    return { ok: false, error: "IN_USE", flows: flowList };
  }

  await db.delete(orgSkills).where(and(eq(orgSkills.orgId, orgId), eq(orgSkills.id, skillId)));

  await deleteLibraryPackage("skills", orgId, skillId);

  return { ok: true };
}

// --- Extensions ---

/** List all extensions in the org with usedByFlows count (built-in + org). */
export async function listOrgExtensions(orgId: string) {
  const data = await db
    .select()
    .from(orgExtensions)
    .where(eq(orgExtensions.orgId, orgId))
    .orderBy(desc(orgExtensions.createdAt));

  // Count org extensions from junction table
  const flowExtRows = await db
    .select({ extensionId: flowExtensions.extensionId })
    .from(flowExtensions)
    .where(eq(flowExtensions.orgId, orgId));

  const countMap = new Map<string, number>();
  for (const row of flowExtRows) {
    countMap.set(row.extensionId, (countMap.get(row.extensionId) ?? 0) + 1);
  }

  // Count built-in extensions from flow manifests (they can't be in the junction table due to FK)
  const builtInCounts = await countBuiltInUsageFromManifests(orgId, "extensions");

  const orgExtIds = new Set(data.map((row) => row.id));

  // Built-in extensions first
  const builtInItems = [...getBuiltInExtensions().values()]
    .filter((e) => !orgExtIds.has(e.id))
    .map((e) => ({
      id: e.id,
      orgId: null as string | null,
      name: e.name,
      description: e.description,
      source: "built-in" as const,
      createdBy: null as string | null,
      createdAt: "",
      updatedAt: "",
      usedByFlows: builtInCounts.get(e.id) ?? 0,
    }));

  const orgItems = data.map((row) => ({
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    description: row.description,
    source: "user" as const,
    createdBy: row.createdBy,
    createdAt: row.createdAt?.toISOString() ?? "",
    updatedAt: row.updatedAt?.toISOString() ?? "",
    usedByFlows: countMap.get(row.id) ?? 0,
  }));

  return [...builtInItems, ...orgItems];
}

/** Get a single extension with content and list of flows referencing it. */
export async function getOrgExtension(orgId: string, extId: string) {
  // Check built-in extensions first
  const builtIn = getBuiltInExtensions().get(extId);
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
    .from(orgExtensions)
    .where(and(eq(orgExtensions.orgId, orgId), eq(orgExtensions.id, extId)))
    .limit(1);

  if (!data) return null;

  // Fetch flow references from junction table
  const flowExtRefs = await db
    .select({ flowId: flowExtensions.flowId })
    .from(flowExtensions)
    .where(and(eq(flowExtensions.orgId, orgId), eq(flowExtensions.extensionId, extId)));

  const flowIds = flowExtRefs.map((fe) => fe.flowId);

  return {
    id: data.id,
    orgId: data.orgId,
    name: data.name,
    description: data.description,
    content: data.content,
    source: "user" as const,
    createdBy: data.createdBy,
    createdAt: data.createdAt?.toISOString() ?? "",
    updatedAt: data.updatedAt?.toISOString() ?? "",
    flows: await getFlowDisplayNames(flowIds),
  };
}

/** Insert or update an extension in the org library. */
export async function upsertOrgExtension(
  orgId: string,
  ext: {
    id: string;
    name?: string;
    description?: string;
    content: string;
    createdBy?: string;
  },
) {
  const now = new Date();

  const [data] = await db
    .insert(orgExtensions)
    .values({
      id: ext.id,
      orgId,
      name: ext.name ?? null,
      description: ext.description ?? null,
      content: ext.content,
      createdBy: ext.createdBy ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [orgExtensions.orgId, orgExtensions.id],
      set: {
        name: ext.name ?? null,
        description: ext.description ?? null,
        content: ext.content,
        createdBy: ext.createdBy ?? null,
        updatedAt: now,
      },
    })
    .returning();

  return data!;
}

/** Delete an extension. Returns error info if still referenced by flows. */
export async function deleteOrgExtension(
  orgId: string,
  extId: string,
): Promise<{ ok: boolean; error?: string; flows?: { id: string; displayName: string }[] }> {
  const refs = await db
    .select({ flowId: flowExtensions.flowId })
    .from(flowExtensions)
    .where(and(eq(flowExtensions.orgId, orgId), eq(flowExtensions.extensionId, extId)));

  if (refs.length > 0) {
    const flowList = await getFlowDisplayNames(refs.map((r) => r.flowId));
    return { ok: false, error: "IN_USE", flows: flowList };
  }

  await db
    .delete(orgExtensions)
    .where(and(eq(orgExtensions.orgId, orgId), eq(orgExtensions.id, extId)));

  await deleteLibraryPackage("extensions", orgId, extId);

  return { ok: true };
}

// --- Library package Storage (full ZIP) ---

/** Upload a library item's full normalized files to Storage. */
export async function uploadLibraryPackage(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
  normalizedFiles: Record<string, Uint8Array>,
): Promise<void> {
  const zip = zipSync(normalizedFiles, { level: 6 });
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
    logger.warn("Failed to download library package", {
      type,
      orgId,
      itemId,
    });
    return null;
  }
  return unzipSync(new Uint8Array(data));
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

/** Get all skill files for a flow's referenced skills. Returns Map<skillId, files>. */
export async function getFlowSkillFiles(
  flowId: string,
  orgId: string,
): Promise<Map<string, Record<string, Uint8Array>>> {
  const data = await db
    .select({ skillId: flowSkills.skillId })
    .from(flowSkills)
    .where(and(eq(flowSkills.flowId, flowId), eq(flowSkills.orgId, orgId)));

  const entries = await Promise.all(
    data.map(async (row) => {
      const files = await downloadLibraryPackage("skills", orgId, row.skillId);
      return [row.skillId, files] as const;
    }),
  );

  const result = new Map<string, Record<string, Uint8Array>>();
  for (const [id, files] of entries) {
    if (files) result.set(id, files);
  }
  return result;
}

/** Get all extension files for a flow's referenced extensions. Returns Map<extId, files>. */
export async function getFlowExtensionFiles(
  flowId: string,
  orgId: string,
): Promise<Map<string, Record<string, Uint8Array>>> {
  const data = await db
    .select({ extensionId: flowExtensions.extensionId })
    .from(flowExtensions)
    .where(and(eq(flowExtensions.flowId, flowId), eq(flowExtensions.orgId, orgId)));

  const entries = await Promise.all(
    data.map(async (row) => {
      const files = await downloadLibraryPackage("extensions", orgId, row.extensionId);
      return [row.extensionId, files] as const;
    }),
  );

  const result = new Map<string, Record<string, Uint8Array>>();
  for (const [id, files] of entries) {
    if (files) result.set(id, files);
  }
  return result;
}

// --- Flow reference management ---

/** Replace all skill references for a flow. Only org skill IDs are stored (built-in are tracked via manifest). */
export async function setFlowSkills(
  flowId: string,
  orgId: string,
  skillIds: string[],
): Promise<void> {
  // Only org skills can be stored in flow_skills (FK constraint to org_skills)
  const orgSkillIds = skillIds.filter((id) => !isBuiltInSkill(id));

  if (orgSkillIds.length > 0) {
    const existing = await db
      .select({ id: orgSkills.id })
      .from(orgSkills)
      .where(and(eq(orgSkills.orgId, orgId), inArray(orgSkills.id, orgSkillIds)));

    const existingIds = new Set(existing.map((s) => s.id));
    const missing = orgSkillIds.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Skills introuvables dans la bibliotheque: ${missing.join(", ")}`);
    }
  }

  await db
    .delete(flowSkills)
    .where(and(eq(flowSkills.flowId, flowId), eq(flowSkills.orgId, orgId)));

  if (orgSkillIds.length === 0) return;

  const rows = orgSkillIds.map((skillId) => ({
    flowId,
    skillId,
    orgId,
  }));

  await db.insert(flowSkills).values(rows);
}

/** Replace all extension references for a flow. Only org extension IDs are stored (built-in are tracked via manifest). */
export async function setFlowExtensions(
  flowId: string,
  orgId: string,
  extensionIds: string[],
): Promise<void> {
  // Only org extensions can be stored in flow_extensions (FK constraint to org_extensions)
  const orgExtIds = extensionIds.filter((id) => !isBuiltInExtension(id));

  if (orgExtIds.length > 0) {
    const existing = await db
      .select({ id: orgExtensions.id })
      .from(orgExtensions)
      .where(and(eq(orgExtensions.orgId, orgId), inArray(orgExtensions.id, orgExtIds)));

    const existingIds = new Set(existing.map((e) => e.id));
    const missing = orgExtIds.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Extensions introuvables dans la bibliotheque: ${missing.join(", ")}`);
    }
  }

  await db
    .delete(flowExtensions)
    .where(and(eq(flowExtensions.flowId, flowId), eq(flowExtensions.orgId, orgId)));

  if (orgExtIds.length === 0) return;

  const rows = orgExtIds.map((extensionId) => ({
    flowId,
    extensionId,
    orgId,
  }));

  await db.insert(flowExtensions).values(rows);
}
