import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../lib/logger.ts";
import { extractSkillMeta } from "@appstrate/core/validation";
import { parseScopedName } from "@appstrate/core/naming";

export const BUILTIN_SCOPE = "appstrate";

// Module-level directories, initialized by initBuiltInPackages()
let skillsDir: string | null = null;
let extensionsDir: string | null = null;

interface BuiltInPackageItem {
  id: string;
  name: string;
  description: string;
  content: string;
}

let builtInSkills: ReadonlyMap<string, BuiltInPackageItem> = new Map();
let builtInExtensions: ReadonlyMap<string, BuiltInPackageItem> = new Map();

// --- Generic loader ---

interface BuiltInLoadConfig {
  dir: string;
  entryFilter: (entry: string, info: Awaited<ReturnType<typeof stat>>) => boolean;
  idFromEntry: (entry: string) => string;
  contentPath: (baseDir: string, entry: string) => string;
  manifestPath?: (baseDir: string, entry: string) => string;
  extractMeta: boolean;
  typeLabel: string;
}

async function loadBuiltInType(cfg: BuiltInLoadConfig): Promise<Map<string, BuiltInPackageItem>> {
  const result = new Map<string, BuiltInPackageItem>();

  try {
    const entries = await readdir(cfg.dir);
    for (const entry of entries) {
      const entryPath = join(cfg.dir, entry);
      const info = await stat(entryPath).catch(() => null);
      if (!info || !cfg.entryFilter(entry, info)) continue;

      // Determine ID: read manifest.json if available, fallback to entry-based ID
      let id = cfg.idFromEntry(entry);
      if (cfg.manifestPath) {
        const mPath = cfg.manifestPath(cfg.dir, entry);
        try {
          const raw = await readFile(mPath, "utf-8");
          const manifest = JSON.parse(raw);
          if (manifest.name) id = manifest.name;
        } catch {
          // No manifest — use entry-based ID
        }
      }

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
export async function initBuiltInPackages(dataDir?: string): Promise<void> {
  if (!dataDir) {
    logger.info("Built-in packages disabled (no dataDir)");
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
      manifestPath: (baseDir, entry) => join(baseDir, entry, "manifest.json"),
      extractMeta: true,
      typeLabel: "skill",
    }),
    loadBuiltInType({
      dir: extensionsDir,
      entryFilter: (_entry, info) => info.isDirectory(),
      idFromEntry: (entry) => entry,
      contentPath: (baseDir, entry) => join(baseDir, entry, "extension.ts"),
      manifestPath: (baseDir, entry) => join(baseDir, entry, "manifest.json"),
      extractMeta: false,
      typeLabel: "extension",
    }),
  ]);

  builtInSkills = skills;
  builtInExtensions = extensions;

  logger.info("Built-in packages loaded", {
    skills: skills.size,
    extensions: extensions.size,
  });
}

export function getBuiltInSkills(): ReadonlyMap<string, BuiltInPackageItem> {
  return builtInSkills;
}

export function getBuiltInExtensions(): ReadonlyMap<string, BuiltInPackageItem> {
  return builtInExtensions;
}

export function isBuiltInSkill(id: string): boolean {
  return builtInSkills.has(id);
}

export function isBuiltInExtension(id: string): boolean {
  return builtInExtensions.has(id);
}

/** Resolve a built-in skill by scoped ID (@scope/name). */
export function resolveBuiltInSkill(id: string): BuiltInPackageItem | undefined {
  return builtInSkills.get(id);
}

/** Resolve a built-in extension by scoped ID (@scope/name). */
export function resolveBuiltInExtension(id: string): BuiltInPackageItem | undefined {
  return builtInExtensions.get(id);
}

/** Get all files for a built-in skill (for ZIP packaging). */
export async function getBuiltInSkillFiles(id: string): Promise<Record<string, Uint8Array> | null> {
  if (!resolveBuiltInSkill(id) || !skillsDir) return null;

  const parsed = parseScopedName(id);
  if (!parsed) return null;
  const slug = parsed.name;
  const skillDir = join(skillsDir, slug);
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
  if (!resolveBuiltInExtension(id) || !extensionsDir) return null;

  const parsed = parseScopedName(id);
  if (!parsed) return null;
  const slug = parsed.name;
  const extPath = join(extensionsDir, slug, "extension.ts");
  try {
    const content = await readFile(extPath);
    return new Uint8Array(content);
  } catch {
    return null;
  }
}
