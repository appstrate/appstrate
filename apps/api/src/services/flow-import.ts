import { unzipSync } from "fflate";
import { validateManifest } from "./schema.ts";
import { insertUserFlow } from "./user-flows.ts";
import { createVersionAndUpload } from "./flow-versions.ts";
import { extractSkillMeta } from "./skill-utils.ts";
import { logger } from "../lib/logger.ts";
import type { SkillMeta } from "../types/index.ts";

const MAX_ZIP_SIZE = 10 * 1024 * 1024; // 10 MB

export interface ImportResult {
  flowId: string;
  displayName: string;
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
  const paths = Object.keys(files).filter((p) => !p.endsWith("/"));

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

  return { manifest, prompt };
}

export async function importFlowFromZip(
  zipBuffer: Buffer,
  existingFlowIds: string[],
  userId: string,
): Promise<ImportResult> {
  const { manifest, prompt } = parseFlowZip(zipBuffer);

  const metadata = manifest.metadata as { name: string; displayName: string };
  const requires = (manifest.requires ?? {}) as {
    skills?: { id: string }[];
    extensions?: { id: string }[];
  };
  const skills = requires.skills ?? [];
  const extensions = requires.extensions ?? [];
  const flowId = metadata.name;
  logger.info("importFlowFromZip: parsed manifest", { flowId, displayName: metadata.displayName });

  // Check name collision
  if (existingFlowIds.includes(flowId)) {
    throw new FlowImportError(
      "NAME_COLLISION",
      `Un flow avec l'identifiant '${flowId}' existe déjà`,
    );
  }

  logger.info("importFlowFromZip: metadata extracted", {
    flowId,
    skillCount: skills.length,
    skills: skills.map((s) => s.id),
    extensionCount: extensions.length,
    extensions: extensions.map((e) => e.id),
  });

  // Persist metadata to DB (skills + extensions are inside manifest.requires)
  logger.info("importFlowFromZip: inserting into DB", { flowId });
  try {
    await insertUserFlow(flowId, manifest, prompt);
  } catch (err) {
    logger.error("importFlowFromZip: DB insert failed", {
      flowId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
  logger.info("importFlowFromZip: DB insert success", { flowId });

  // Create version snapshot and upload ZIP to Storage (non-blocking — import succeeds even if Storage fails)
  try {
    logger.info("importFlowFromZip: creating version + uploading ZIP", { flowId, userId });
    await createVersionAndUpload(flowId, manifest, prompt, userId, zipBuffer);
    logger.info("importFlowFromZip: version + ZIP uploaded", { flowId });
  } catch (err) {
    logger.error("Failed to upload flow package to Storage", {
      flowId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  return { flowId, displayName: metadata.displayName };
}
