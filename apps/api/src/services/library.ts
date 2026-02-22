import { zipSync, unzipSync } from "fflate";
import { supabase, ensureBucket } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import {
  getBuiltInSkills,
  getBuiltInExtensions,
  isBuiltInSkill,
  isBuiltInExtension,
} from "./builtin-library.ts";

const LIBRARY_BUCKET = "library-packages";

/** Ensure the library-packages Storage bucket exists. Call once at boot. */
export const ensureLibraryBucket = () => ensureBucket(LIBRARY_BUCKET);

/** Count built-in skill/extension usage from flow manifests (since built-in IDs can't be in junction tables). */
async function countBuiltInUsageFromManifests(
  orgId: string,
  field: "skills" | "extensions",
): Promise<Map<string, number>> {
  const { data: flows } = await supabase.from("flows").select("manifest").eq("org_id", orgId);

  const countMap = new Map<string, number>();
  const isBuiltIn = field === "skills" ? isBuiltInSkill : isBuiltInExtension;

  for (const flow of flows ?? []) {
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
  const { data: flowRows } = await supabase.from("flows").select("id, manifest").in("id", flowIds);
  return (flowRows ?? []).map((f) => ({
    id: f.id,
    displayName:
      (f.manifest as { metadata?: { displayName?: string } })?.metadata?.displayName ?? f.id,
  }));
}

// --- Skills ---

/** List all skills in the org with usedByFlows count (built-in + org). */
export async function listOrgSkills(orgId: string) {
  const { data, error } = await supabase
    .from("org_skills")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) throw error;

  // Count org skills from junction table
  const { data: flowSkillRows } = await supabase
    .from("flow_skills")
    .select("skill_id")
    .eq("org_id", orgId);

  const countMap = new Map<string, number>();
  for (const row of flowSkillRows ?? []) {
    countMap.set(row.skill_id, (countMap.get(row.skill_id) ?? 0) + 1);
  }

  // Count built-in skills from flow manifests (they can't be in the junction table due to FK)
  const builtInCounts = await countBuiltInUsageFromManifests(orgId, "skills");

  const orgSkillIds = new Set((data ?? []).map((row) => row.id));

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

  const orgItems = (data ?? []).map((row) => ({
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description,
    source: "user" as const,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

  const { data, error } = await supabase
    .from("org_skills")
    .select("*, flow_skills(flow_id)")
    .eq("org_id", orgId)
    .eq("id", skillId)
    .single();

  if (error || !data) return null;

  const flowIds = Array.isArray(data.flow_skills)
    ? data.flow_skills.map((fs: { flow_id: string }) => fs.flow_id)
    : [];

  return {
    id: data.id,
    orgId: data.org_id,
    name: data.name,
    description: data.description,
    content: data.content,
    source: "user" as const,
    createdBy: data.created_by,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
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
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("org_skills")
    .upsert(
      {
        id: skill.id,
        org_id: orgId,
        name: skill.name ?? null,
        description: skill.description ?? null,
        content: skill.content,
        created_by: skill.createdBy ?? null,
        updated_at: now,
      },
      { onConflict: "org_id,id" },
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Delete a skill. Returns error info if still referenced by flows. */
export async function deleteOrgSkill(
  orgId: string,
  skillId: string,
): Promise<{ ok: boolean; error?: string; flows?: { id: string; displayName: string }[] }> {
  const { data: refs } = await supabase
    .from("flow_skills")
    .select("flow_id")
    .eq("org_id", orgId)
    .eq("skill_id", skillId);

  if (refs && refs.length > 0) {
    const flows = await getFlowDisplayNames(refs.map((r) => r.flow_id));
    return { ok: false, error: "IN_USE", flows };
  }

  const { error } = await supabase
    .from("org_skills")
    .delete()
    .eq("org_id", orgId)
    .eq("id", skillId);

  if (error) throw error;

  await deleteLibraryPackage("skills", orgId, skillId);

  return { ok: true };
}

// --- Extensions ---

/** List all extensions in the org with usedByFlows count (built-in + org). */
export async function listOrgExtensions(orgId: string) {
  const { data, error } = await supabase
    .from("org_extensions")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (error) throw error;

  // Count org extensions from junction table
  const { data: flowExtRows } = await supabase
    .from("flow_extensions")
    .select("extension_id")
    .eq("org_id", orgId);

  const countMap = new Map<string, number>();
  for (const row of flowExtRows ?? []) {
    countMap.set(row.extension_id, (countMap.get(row.extension_id) ?? 0) + 1);
  }

  // Count built-in extensions from flow manifests (they can't be in the junction table due to FK)
  const builtInCounts = await countBuiltInUsageFromManifests(orgId, "extensions");

  const orgExtIds = new Set((data ?? []).map((row) => row.id));

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

  const orgItems = (data ?? []).map((row) => ({
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description,
    source: "user" as const,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

  const { data, error } = await supabase
    .from("org_extensions")
    .select("*, flow_extensions(flow_id)")
    .eq("org_id", orgId)
    .eq("id", extId)
    .single();

  if (error || !data) return null;

  const flowIds = Array.isArray(data.flow_extensions)
    ? data.flow_extensions.map((fe: { flow_id: string }) => fe.flow_id)
    : [];

  return {
    id: data.id,
    orgId: data.org_id,
    name: data.name,
    description: data.description,
    content: data.content,
    source: "user" as const,
    createdBy: data.created_by,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
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
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("org_extensions")
    .upsert(
      {
        id: ext.id,
        org_id: orgId,
        name: ext.name ?? null,
        description: ext.description ?? null,
        content: ext.content,
        created_by: ext.createdBy ?? null,
        updated_at: now,
      },
      { onConflict: "org_id,id" },
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Delete an extension. Returns error info if still referenced by flows. */
export async function deleteOrgExtension(
  orgId: string,
  extId: string,
): Promise<{ ok: boolean; error?: string; flows?: { id: string; displayName: string }[] }> {
  const { data: refs } = await supabase
    .from("flow_extensions")
    .select("flow_id")
    .eq("org_id", orgId)
    .eq("extension_id", extId);

  if (refs && refs.length > 0) {
    const flows = await getFlowDisplayNames(refs.map((r) => r.flow_id));
    return { ok: false, error: "IN_USE", flows };
  }

  const { error } = await supabase
    .from("org_extensions")
    .delete()
    .eq("org_id", orgId)
    .eq("id", extId);

  if (error) throw error;

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
  const { error } = await supabase.storage.from(LIBRARY_BUCKET).upload(path, zip, {
    contentType: "application/zip",
    upsert: true,
  });
  if (error) {
    logger.error("Failed to upload library package", { type, orgId, itemId, error: error.message });
    throw error;
  }
}

/** Download a library item's full files from Storage. Returns normalized file map or null. */
async function downloadLibraryPackage(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
): Promise<Record<string, Uint8Array> | null> {
  const path = `${orgId}/${type}/${itemId}.zip`;
  const { data, error } = await supabase.storage.from(LIBRARY_BUCKET).download(path);
  if (error || !data) {
    logger.warn("Failed to download library package", {
      type,
      orgId,
      itemId,
      error: error?.message,
    });
    return null;
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  return unzipSync(new Uint8Array(buffer));
}

/** Delete a library item's package from Storage. */
async function deleteLibraryPackage(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
): Promise<void> {
  const path = `${orgId}/${type}/${itemId}.zip`;
  await supabase.storage.from(LIBRARY_BUCKET).remove([path]);
}

/** Get all skill files for a flow's referenced skills. Returns Map<skillId, files>. */
export async function getFlowSkillFiles(
  flowId: string,
  orgId: string,
): Promise<Map<string, Record<string, Uint8Array>>> {
  const { data, error } = await supabase
    .from("flow_skills")
    .select("skill_id")
    .eq("flow_id", flowId)
    .eq("org_id", orgId);

  if (error) throw error;

  const result = new Map<string, Record<string, Uint8Array>>();
  for (const row of data ?? []) {
    const files = await downloadLibraryPackage("skills", orgId, row.skill_id);
    if (files) {
      result.set(row.skill_id, files);
    }
  }
  return result;
}

/** Get all extension files for a flow's referenced extensions. Returns Map<extId, files>. */
export async function getFlowExtensionFiles(
  flowId: string,
  orgId: string,
): Promise<Map<string, Record<string, Uint8Array>>> {
  const { data, error } = await supabase
    .from("flow_extensions")
    .select("extension_id")
    .eq("flow_id", flowId)
    .eq("org_id", orgId);

  if (error) throw error;

  const result = new Map<string, Record<string, Uint8Array>>();
  for (const row of data ?? []) {
    const files = await downloadLibraryPackage("extensions", orgId, row.extension_id);
    if (files) {
      result.set(row.extension_id, files);
    }
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
    const { data: existing } = await supabase
      .from("org_skills")
      .select("id")
      .eq("org_id", orgId)
      .in("id", orgSkillIds);

    const existingIds = new Set((existing ?? []).map((s) => s.id));
    const missing = orgSkillIds.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Skills introuvables dans la bibliotheque: ${missing.join(", ")}`);
    }
  }

  await supabase.from("flow_skills").delete().eq("flow_id", flowId).eq("org_id", orgId);

  if (orgSkillIds.length === 0) return;

  const rows = orgSkillIds.map((skillId) => ({
    flow_id: flowId,
    skill_id: skillId,
    org_id: orgId,
  }));

  const { error } = await supabase.from("flow_skills").insert(rows);
  if (error) throw error;
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
    const { data: existing } = await supabase
      .from("org_extensions")
      .select("id")
      .eq("org_id", orgId)
      .in("id", orgExtIds);

    const existingIds = new Set((existing ?? []).map((e) => e.id));
    const missing = orgExtIds.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Extensions introuvables dans la bibliotheque: ${missing.join(", ")}`);
    }
  }

  await supabase.from("flow_extensions").delete().eq("flow_id", flowId).eq("org_id", orgId);

  if (orgExtIds.length === 0) return;

  const rows = orgExtIds.map((extensionId) => ({
    flow_id: flowId,
    extension_id: extensionId,
    org_id: orgId,
  }));

  const { error } = await supabase.from("flow_extensions").insert(rows);
  if (error) throw error;
}
