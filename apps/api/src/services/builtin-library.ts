import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../lib/logger.ts";
import { extractSkillMeta } from "@appstrate/validation";

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

// --- Generic loader ---

interface BuiltInLoadConfig {
  dir: string;
  entryFilter: (entry: string, info: Awaited<ReturnType<typeof stat>>) => boolean;
  idFromEntry: (entry: string) => string;
  contentPath: (baseDir: string, entry: string) => string;
  extractMeta: boolean;
  typeLabel: string;
}

async function loadBuiltInType(cfg: BuiltInLoadConfig): Promise<Map<string, BuiltInLibraryItem>> {
  const result = new Map<string, BuiltInLibraryItem>();

  try {
    const entries = await readdir(cfg.dir);
    for (const entry of entries) {
      const entryPath = join(cfg.dir, entry);
      const info = await stat(entryPath).catch(() => null);
      if (!info || !cfg.entryFilter(entry, info)) continue;

      const id = cfg.idFromEntry(entry);
      const contentFilePath = cfg.contentPath(cfg.dir, entry);
      try {
        const content = await readFile(contentFilePath, "utf-8");
        let name = id;
        let description = "";
        if (cfg.extractMeta) {
          const meta = extractSkillMeta(content);
          name = meta.name || id;
          description = meta.description || "";
        }
        result.set(id, { id, name, description, content });
      } catch {
        logger.warn(`Skipping built-in ${cfg.typeLabel}: unreadable`, { id });
      }
    }
  } catch {
    // directory doesn't exist — that's fine
  }

  return result;
}

/** Load built-in skills and extensions from dataDir. Call once at boot. */
export async function initBuiltInLibrary(dataDir?: string): Promise<void> {
  if (!dataDir) {
    logger.info("Built-in library disabled (no dataDir)");
    return;
  }

  skillsDir = join(dataDir, "skills");
  extensionsDir = join(dataDir, "extensions");

  const [skills, extensions] = await Promise.all([
    loadBuiltInType({
      dir: skillsDir,
      entryFilter: (_entry, info) => info.isDirectory(),
      idFromEntry: (entry) => entry,
      contentPath: (baseDir, entry) => join(baseDir, entry, "SKILL.md"),
      extractMeta: true,
      typeLabel: "skill",
    }),
    loadBuiltInType({
      dir: extensionsDir,
      entryFilter: (entry, info) => info.isFile() && entry.endsWith(".ts"),
      idFromEntry: (entry) => entry.replace(/\.ts$/, ""),
      contentPath: (baseDir, entry) => join(baseDir, entry),
      extractMeta: false,
      typeLabel: "extension",
    }),
  ]);

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
