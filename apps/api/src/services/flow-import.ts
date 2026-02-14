import { unzipSync } from "fflate";
import { validateManifest } from "./schema.ts";
import { insertUserFlow } from "./user-flows.ts";
import { extractSkillDescription } from "./skill-utils.ts";

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

export async function importFlowFromZip(
  zipBuffer: Buffer,
  existingFlowIds: string[],
): Promise<ImportResult> {
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
  const metadata = manifest.metadata as { name: string; displayName: string };
  const flowId = metadata.name;

  // Check name collision
  if (existingFlowIds.includes(flowId)) {
    throw new FlowImportError(
      "NAME_COLLISION",
      `Un flow avec l'identifiant '${flowId}' existe déjà`,
    );
  }

  // Extract prompt.md
  const prompt = getFileText(files, root + "prompt.md");
  if (!prompt) {
    throw new FlowImportError("MISSING_PROMPT", "prompt.md introuvable dans le ZIP");
  }

  // Extract skills (optional)
  const skills: { id: string; description: string; content: string }[] = [];
  const skillPrefix = root + "skills/";

  for (const [path, data] of Object.entries(files)) {
    if (!path.startsWith(skillPrefix) || path.endsWith("/")) continue;
    if (!path.endsWith("/SKILL.md")) continue;

    // Extract skill id from path: skills/{id}/SKILL.md
    const relative = path.slice(skillPrefix.length);
    const parts = relative.split("/");
    if (parts.length !== 2) continue;

    const skillId = parts[0]!;
    const content = new TextDecoder().decode(data);

    const description = extractSkillDescription(content);

    skills.push({ id: skillId, description, content });
  }

  // Persist to DB
  await insertUserFlow(flowId, manifest, prompt, skills);

  return { flowId, displayName: metadata.displayName };
}
