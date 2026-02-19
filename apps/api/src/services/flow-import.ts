import { unzipSync } from "fflate";
import { validateManifest } from "./schema.ts";
import { insertUserFlow } from "./user-flows.ts";
import { createVersionAndUpload } from "./flow-versions.ts";
import { extractSkillMeta } from "./skill-utils.ts";
import {
  upsertOrgSkill,
  upsertOrgExtension,
  setFlowSkills,
  setFlowExtensions,
  uploadLibraryPackage,
} from "./library.ts";
import { logger } from "../lib/logger.ts";
import { supabase } from "../lib/supabase.ts";
import type { SkillMeta } from "../types/index.ts";

const MAX_ZIP_SIZE = 10 * 1024 * 1024; // 10 MB

export interface ImportResult {
  flowId: string;
  displayName: string;
  skillsCreated: number;
  skillsMatched: number;
  extensionsCreated: number;
  extensionsMatched: number;
}

export class FlowImportError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Find the root prefix inside the ZIP.
 * Files can be at the root or inside a single top-level folder (GitHub ZIP pattern).
 */
function findRoot(files: Record<string, Uint8Array>): string {
  const paths = Object.keys(files).filter((p) => !p.endsWith("/") && !p.startsWith("__MACOSX/"));

  // Check if manifest.json is at root
  if (paths.some((p) => p === "manifest.json")) return "";

  // Check for single top-level directory containing manifest.json
  const topDirs = new Set<string>();
  for (const p of paths) {
    const first = p.split("/")[0];
    if (first) topDirs.add(first);
  }

  if (topDirs.size === 1) {
    const prefix = [...topDirs][0]! + "/";
    if (paths.some((p) => p === prefix + "manifest.json")) return prefix;
  }

  throw new FlowImportError("MISSING_MANIFEST", "manifest.json introuvable dans le ZIP");
}

function getFileText(files: Record<string, Uint8Array>, path: string): string | null {
  const data = files[path];
  if (!data) return null;
  return new TextDecoder().decode(data);
}

export interface ParsedFlowZip {
  manifest: Record<string, unknown>;
  prompt: string;
  files: Record<string, Uint8Array>;
}

/** Parse a flow ZIP buffer and extract manifest, prompt, skills metadata, and extensions metadata. */
export function parseFlowZip(zipBuffer: Buffer): ParsedFlowZip {
  if (zipBuffer.length > MAX_ZIP_SIZE) {
    throw new FlowImportError(
      "FILE_TOO_LARGE",
      `Le fichier ZIP dépasse la taille maximale de ${MAX_ZIP_SIZE / 1024 / 1024} MB`,
    );
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(zipBuffer));
  } catch {
    throw new FlowImportError("ZIP_INVALID", "Le fichier ZIP est corrompu ou illisible");
  }

  const root = findRoot(files);

  // Parse manifest.json
  const manifestText = getFileText(files, root + "manifest.json");
  if (!manifestText) {
    throw new FlowImportError("MISSING_MANIFEST", "manifest.json introuvable dans le ZIP");
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestText);
  } catch {
    throw new FlowImportError("INVALID_MANIFEST", "manifest.json n'est pas un JSON valide");
  }

  const validation = validateManifest(manifestRaw);
  if (!validation.valid) {
    throw new FlowImportError("INVALID_MANIFEST", "manifest.json invalide", validation.errors);
  }

  const manifest = validation.manifest as Record<string, unknown>;

  // Extract prompt.md
  const prompt = getFileText(files, root + "prompt.md");
  if (!prompt) {
    throw new FlowImportError("MISSING_PROMPT", "prompt.md introuvable dans le ZIP");
  }

  // Merge ZIP-detected SKILL.md files with manifest-declared skills
  const requires = (manifest.requires ?? {}) as Record<string, unknown>;
  const manifestSkills = (requires.skills ?? []) as SkillMeta[];
  const manifestSkillMap = new Map(manifestSkills.map((s) => [s.id, s]));

  const skillPrefix = root + "skills/";
  for (const [path, data] of Object.entries(files)) {
    if (!path.startsWith(skillPrefix) || path.endsWith("/")) continue;
    if (!path.endsWith("/SKILL.md")) continue;

    const relative = path.slice(skillPrefix.length);
    const parts = relative.split("/");
    if (parts.length !== 2) continue;

    const skillId = parts[0]!;
    const content = new TextDecoder().decode(data);
    const { name, description } = extractSkillMeta(content);

    if (!manifestSkillMap.has(skillId)) {
      // File found in ZIP but not declared in manifest — add with extracted metadata
      manifestSkillMap.set(skillId, {
        id: skillId,
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
      });
    }
  }

  // Write merged skills back into manifest.requires.skills
  (manifest.requires as Record<string, unknown>).skills = [...manifestSkillMap.values()];

  // Merge ZIP-detected .ts extensions with manifest-declared extensions
  const manifestExtensions = (requires.extensions ?? []) as {
    id: string;
    name?: string;
    description?: string;
  }[];
  const manifestExtMap = new Map(manifestExtensions.map((e) => [e.id, e]));

  const extPrefix = root + "extensions/";
  for (const [path] of Object.entries(files)) {
    if (!path.startsWith(extPrefix) || path.endsWith("/")) continue;
    if (!path.endsWith(".ts")) continue;

    const filename = path.slice(extPrefix.length);
    if (filename.includes("/")) continue;

    const id = filename.replace(/\.ts$/, "");
    if (!manifestExtMap.has(id)) {
      manifestExtMap.set(id, { id });
    }
  }

  // Write merged extensions back into manifest.requires.extensions
  (manifest.requires as Record<string, unknown>).extensions = [...manifestExtMap.values()];

  return { manifest, prompt, files };
}

/**
 * Extract skills and extensions from pre-decompressed ZIP files, upsert them into the org library,
 * and create flow_skills/flow_extensions references.
 * Accepts the `files` map already produced by `parseFlowZip` to avoid decompressing twice.
 */
export async function upsertSkillsAndExtensionsFromFiles(
  files: Record<string, Uint8Array>,
  flowId: string,
  orgId: string,
  userId: string,
): Promise<{
  skillsCreated: number;
  skillsMatched: number;
  extensionsCreated: number;
  extensionsMatched: number;
}> {
  const root = findRoot(files);
  let skillsCreated = 0;
  let skillsMatched = 0;
  let extensionsCreated = 0;
  let extensionsMatched = 0;

  // Process skills — group all files per skill directory
  const skillPrefix = root + "skills/";
  const skillIds: string[] = [];
  const skillFilesMap = new Map<string, Record<string, Uint8Array>>();

  for (const [path, data] of Object.entries(files)) {
    if (!path.startsWith(skillPrefix) || path.endsWith("/")) continue;

    const relative = path.slice(skillPrefix.length);
    const slashIdx = relative.indexOf("/");
    if (slashIdx === -1) continue; // must be inside a skill subdirectory

    const skillId = relative.slice(0, slashIdx);
    const filePath = relative.slice(slashIdx + 1);

    if (!skillFilesMap.has(skillId)) {
      skillFilesMap.set(skillId, {});
    }
    skillFilesMap.get(skillId)![filePath] = data;
  }

  for (const [skillId, skillFiles] of skillFilesMap) {
    const skillMdContent = skillFiles["SKILL.md"];
    if (!skillMdContent) continue; // skip skills without SKILL.md

    const content = new TextDecoder().decode(skillMdContent);
    const { name, description } = extractSkillMeta(content);

    // Check if skill already exists in org
    const { data: existing } = await supabase
      .from("org_skills")
      .select("id")
      .eq("org_id", orgId)
      .eq("id", skillId)
      .single();

    if (existing) {
      // Reuse existing — don't overwrite content
      skillsMatched++;
    } else {
      // Create new in library (DB metadata + Storage full package)
      await upsertOrgSkill(orgId, {
        id: skillId,
        name: name || undefined,
        description: description || undefined,
        content,
        createdBy: userId,
      });
      await uploadLibraryPackage("skills", orgId, skillId, skillFiles);
      skillsCreated++;
    }

    skillIds.push(skillId);
  }

  // Process extensions — collect all extension files
  const extPrefix = root + "extensions/";
  const extIds: string[] = [];
  const extFilesMap = new Map<string, Record<string, Uint8Array>>();

  for (const [path, data] of Object.entries(files)) {
    if (!path.startsWith(extPrefix) || path.endsWith("/")) continue;
    if (!path.endsWith(".ts")) continue;

    const filename = path.slice(extPrefix.length);
    if (filename.includes("/")) continue;

    const extId = filename.replace(/\.ts$/, "");
    extFilesMap.set(extId, { [filename]: data });
  }

  for (const [extId, extFiles] of extFilesMap) {
    const tsFilename = Object.keys(extFiles)[0]!;
    const content = new TextDecoder().decode(extFiles[tsFilename]!);

    // Check if extension already exists in org
    const { data: existing } = await supabase
      .from("org_extensions")
      .select("id")
      .eq("org_id", orgId)
      .eq("id", extId)
      .single();

    if (existing) {
      extensionsMatched++;
    } else {
      await upsertOrgExtension(orgId, {
        id: extId,
        content,
        createdBy: userId,
      });
      await uploadLibraryPackage("extensions", orgId, extId, extFiles);
      extensionsCreated++;
    }

    extIds.push(extId);
  }

  // Create flow references
  if (skillIds.length > 0) {
    await setFlowSkills(flowId, orgId, skillIds);
  }
  if (extIds.length > 0) {
    await setFlowExtensions(flowId, orgId, extIds);
  }

  return { skillsCreated, skillsMatched, extensionsCreated, extensionsMatched };
}

export async function importFlowFromZip(
  zipBuffer: Buffer,
  existingFlowIds: string[],
  userId: string,
  orgId: string,
): Promise<ImportResult> {
  const { manifest, prompt, files } = parseFlowZip(zipBuffer);

  const metadata = manifest.metadata as { name: string; displayName: string };
  const flowId = metadata.name;
  logger.info("importFlowFromZip: parsed manifest", { flowId, displayName: metadata.displayName });

  // Check name collision
  if (existingFlowIds.includes(flowId)) {
    throw new FlowImportError(
      "NAME_COLLISION",
      `Un flow avec l'identifiant '${flowId}' existe déjà`,
    );
  }

  // Persist metadata to DB
  logger.info("importFlowFromZip: inserting into DB", { flowId });
  try {
    await insertUserFlow(flowId, orgId, manifest, prompt);
  } catch (err) {
    logger.error("importFlowFromZip: DB insert failed", {
      flowId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
  logger.info("importFlowFromZip: DB insert success", { flowId });

  // Upsert skills/extensions from ZIP into org library + create references
  const libResult = await upsertSkillsAndExtensionsFromFiles(files, flowId, orgId, userId);
  logger.info("importFlowFromZip: library upsert done", {
    flowId,
    ...libResult,
  });

  // Create version snapshot and upload ZIP to Storage (non-blocking)
  try {
    logger.info("importFlowFromZip: creating version + uploading ZIP", { flowId, userId });
    await createVersionAndUpload(flowId, userId, zipBuffer);
    logger.info("importFlowFromZip: version + ZIP uploaded", { flowId });
  } catch (err) {
    logger.error("Failed to upload flow package to Storage", {
      flowId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  return {
    flowId,
    displayName: metadata.displayName,
    ...libResult,
  };
}
