import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../lib/logger.ts";
import { extractSkillMeta } from "./skill-utils.ts";

// Module-level directories, initialized by initBuiltInLibrary()
let skillsDir: string | null = null;
let extensionsDir: string | null = null;

interface BuiltInLibraryItem {
  id: string;
  name: string;
  description: string;
  content: string;
}

let builtInSkills: ReadonlyMap<string, BuiltInLibraryItem> = new Map();
let builtInExtensions: ReadonlyMap<string, BuiltInLibraryItem> = new Map();

/** Load built-in skills and extensions from dataDir. Call once at boot. */
export async function initBuiltInLibrary(dataDir?: string): Promise<void> {
  if (!dataDir) {
    logger.info("Built-in library disabled (no dataDir)");
    return;
  }

  skillsDir = join(dataDir, "skills");
  extensionsDir = join(dataDir, "extensions");

  const skills = new Map<string, BuiltInLibraryItem>();
  const extensions = new Map<string, BuiltInLibraryItem>();

  // Load skills from {dataDir}/skills/{id}/SKILL.md
  try {
    const entries = await readdir(skillsDir);
    for (const entry of entries) {
      const skillPath = join(skillsDir, entry);
      const info = await stat(skillPath).catch(() => null);
      if (!info?.isDirectory()) continue;

      const skillFile = join(skillPath, "SKILL.md");
      try {
        const content = await readFile(skillFile, "utf-8");
        const meta = extractSkillMeta(content);
        skills.set(entry, {
          id: entry,
          name: meta.name || entry,
          description: meta.description || "",
          content,
        });
      } catch {
        logger.warn("Skipping built-in skill: SKILL.md not found or unreadable", { id: entry });
      }
    }
  } catch {
    // skills/ doesn't exist — that's fine
  }

  // Load extensions from {dataDir}/extensions/{id}.ts
  try {
    const entries = await readdir(extensionsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;
      const extPath = join(extensionsDir, entry);
      const info = await stat(extPath).catch(() => null);
      if (!info?.isFile()) continue;

      const id = entry.replace(/\.ts$/, "");
      try {
        const content = await readFile(extPath, "utf-8");
        extensions.set(id, {
          id,
          name: id,
          description: "",
          content,
        });
      } catch {
        logger.warn("Skipping built-in extension: unreadable", { id });
      }
    }
  } catch {
    // extensions/ doesn't exist — that's fine
  }

  builtInSkills = skills;
  builtInExtensions = extensions;

  logger.info("Built-in library loaded", {
    skills: skills.size,
    extensions: extensions.size,
  });
}

export function getBuiltInSkills(): ReadonlyMap<string, BuiltInLibraryItem> {
  return builtInSkills;
}

export function getBuiltInExtensions(): ReadonlyMap<string, BuiltInLibraryItem> {
  return builtInExtensions;
}

export function isBuiltInSkill(id: string): boolean {
  return builtInSkills.has(id);
}

export function isBuiltInExtension(id: string): boolean {
  return builtInExtensions.has(id);
}

/** Get all files for a built-in skill (for ZIP packaging). */
export async function getBuiltInSkillFiles(id: string): Promise<Record<string, Uint8Array> | null> {
  if (!builtInSkills.has(id) || !skillsDir) return null;

  const skillDir = join(skillsDir, id);
  const files: Record<string, Uint8Array> = {};

  async function readDirRecursive(dir: string, prefix: string) {
    let items: string[];
    try {
      items = await readdir(dir);
    } catch {
      return;
    }
    for (const item of items) {
      const fullPath = join(dir, item);
      const info = await stat(fullPath).catch(() => null);
      if (!info) continue;
      const relativePath = prefix ? `${prefix}/${item}` : item;
      if (info.isDirectory()) {
        await readDirRecursive(fullPath, relativePath);
      } else {
        const content = await readFile(fullPath);
        files[relativePath] = new Uint8Array(content);
      }
    }
  }

  await readDirRecursive(skillDir, "");
  return Object.keys(files).length > 0 ? files : null;
}

/** Get the file content for a built-in extension (for ZIP packaging). */
export async function getBuiltInExtensionFile(id: string): Promise<Uint8Array | null> {
  if (!builtInExtensions.has(id) || !extensionsDir) return null;

  const extPath = join(extensionsDir, `${id}.ts`);
  try {
    const content = await readFile(extPath);
    return new Uint8Array(content);
  } catch {
    return null;
  }
}
