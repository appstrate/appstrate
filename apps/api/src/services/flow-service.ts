import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { eq, and, count } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { validateManifest } from "@appstrate/core/validation";
import {
  isBuiltInSkill,
  isBuiltInExtension,
  resolveBuiltInSkill,
  resolveBuiltInExtension,
  getBuiltInSkills,
  getBuiltInExtensions,
} from "./builtin-packages.ts";
import type { Manifest } from "@appstrate/core/validation";
import type { FlowManifest, LoadedFlow } from "../types/index.ts";

// Module-level directory, initialized by initPackageService()
let packagesDir: string | null = null;

// Immutable cache for built-in flows (loaded once at boot, never mutated)
let builtInFlows: ReadonlyMap<string, LoadedFlow> = new Map();

/** Get the packages directory path (null if DATA_DIR not configured). */
export function getPackagesDir(): string | null {
  return packagesDir;
}

/** Load built-in flows from filesystem into the immutable cache. Call once at boot. */
export async function initPackageService(dataDir?: string): Promise<void> {
  if (!dataDir) {
    logger.info("Built-in flows disabled (no dataDir)");
    return;
  }

  packagesDir = join(dataDir, "flows");
  const flowsMap = new Map<string, LoadedFlow>();

  let entries: string[];
  try {
    entries = await readdir(packagesDir);
  } catch {
    logger.warn("Flows directory not found", { path: packagesDir });
    builtInFlows = flowsMap;
    return;
  }

  for (const entry of entries) {
    const flowPath = join(packagesDir, entry);
    const manifestFile = Bun.file(join(flowPath, "manifest.json"));
    const promptFile = Bun.file(join(flowPath, "prompt.md"));

    if (!(await manifestFile.exists()) || !(await promptFile.exists())) {
      continue;
    }

    try {
      const raw = await manifestFile.json();
      const prompt = await promptFile.text();

      const validation = validateManifest(raw);
      if (!validation.valid) {
        logger.warn("Skipping flow: invalid manifest", { entry });
        continue;
      }

      const manifest = raw as FlowManifest;
      const packageId = manifest.name;

      // Resolve skill/extension IDs to SkillMeta using built-in packages
      const skillsMap = (manifest.requires.skills ?? {}) as Record<string, string>;
      const skills = Object.entries(skillsMap).map(([id, version]) => {
        const builtIn = resolveBuiltInSkill(id);
        return { id, version, name: builtIn?.name, description: builtIn?.description };
      });
      const extensionsMap = (manifest.requires.extensions ?? {}) as Record<string, string>;
      const extensions = Object.entries(extensionsMap).map(([id, version]) => {
        const builtIn = resolveBuiltInExtension(id);
        return { id, version, name: builtIn?.name, description: builtIn?.description };
      });

      flowsMap.set(packageId, {
        id: packageId,
        manifest,
        prompt,
        skills,
        extensions,
        source: "built-in",
      });

      logger.info("Loaded built-in flow", {
        packageId,
        displayName: manifest.displayName,
        skillCount: skills.length,
        extensionCount: extensions.length,
      });
    } catch (e) {
      logger.warn("Skipping flow: parse error", {
        entry,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  builtInFlows = flowsMap;
}

interface DbPackageRow {
  id: string;
  manifest: unknown;
  content: string;
  source?: string;
  depRefs?: {
    dependencyId: string;
    type: string;
    manifest: unknown;
  }[];
}

function dbRowToLoadedFlow(row: DbPackageRow): LoadedFlow {
  const manifest = (row.manifest ?? {
    schemaVersion: "1.0",
    name: row.id,
    version: "0.0.0",
    type: "flow",
    displayName: row.id,
    description: "",
    author: "",
    requires: { services: [] },
  }) as FlowManifest;

  // Read version maps from the flow's manifest
  const manifestSkillsMap = (manifest.requires.skills ?? {}) as Record<string, string>;
  const manifestExtensionsMap = (manifest.requires.extensions ?? {}) as Record<string, string>;

  // Dependencies from packageDependencies joined with packages
  const depSkills = (row.depRefs ?? [])
    .filter((d) => d.type === "skill")
    .map((d) => {
      const m = (d.manifest ?? {}) as Partial<Manifest>;
      return {
        id: d.dependencyId,
        version: manifestSkillsMap[d.dependencyId] ?? "*",
        name: m.displayName ?? undefined,
        description: m.description ?? undefined,
      };
    });

  const depExtensions = (row.depRefs ?? [])
    .filter((d) => d.type === "extension")
    .map((d) => {
      const m = (d.manifest ?? {}) as Partial<Manifest>;
      return {
        id: d.dependencyId,
        version: manifestExtensionsMap[d.dependencyId] ?? "*",
        name: m.displayName ?? undefined,
        description: m.description ?? undefined,
      };
    });

  // Built-in skills/extensions declared in manifest
  const manifestSkills = Object.entries(manifestSkillsMap)
    .filter(([id]) => isBuiltInSkill(id))
    .map(([id, version]) => {
      const builtIn = resolveBuiltInSkill(id);
      return {
        id,
        version,
        name: builtIn?.name,
        description: builtIn?.description,
      };
    });

  const manifestExtensions = Object.entries(manifestExtensionsMap)
    .filter(([id]) => isBuiltInExtension(id))
    .map(([id, version]) => {
      const builtIn = resolveBuiltInExtension(id);
      return {
        id,
        version,
        name: builtIn?.name,
        description: builtIn?.description,
      };
    });

  // Merge: dependency items + built-in items (deduplicate by ID)
  const seenSkillIds = new Set(depSkills.map((s) => s.id));
  const skills = [...depSkills, ...manifestSkills.filter((s) => !seenSkillIds.has(s.id))];

  const seenExtIds = new Set(depExtensions.map((e) => e.id));
  const extensions = [...depExtensions, ...manifestExtensions.filter((e) => !seenExtIds.has(e.id))];

  return {
    id: row.id,
    manifest,
    prompt: row.content,
    skills,
    extensions,
    source: (row.source as "built-in" | "local") ?? "local",
  };
}

/** Get a single package by ID. Checks built-in cache first, then DB filtered by orgId. */
export async function getPackage(id: string, orgId?: string): Promise<LoadedFlow | null> {
  // Built-in flows are global (accessible in all orgs)
  const builtIn = builtInFlows.get(id);
  if (builtIn) return builtIn;

  // User packages are scoped by org
  const conditions = [eq(packages.id, id)];
  if (orgId) {
    conditions.push(eq(packages.orgId, orgId));
  }

  const pkgRows = await db
    .select({
      id: packages.id,
      manifest: packages.manifest,
      content: packages.content,
      source: packages.source,
    })
    .from(packages)
    .where(and(...conditions))
    .limit(1);

  const pkgRow = pkgRows[0];
  if (!pkgRow) return null;

  // Fetch dependencies joined with their package metadata
  const depRefs = await db
    .select({
      dependencyId: packageDependencies.dependencyId,
      type: packages.type,
      manifest: packages.manifest,
    })
    .from(packageDependencies)
    .innerJoin(packages, eq(packageDependencies.dependencyId, packages.id))
    .where(eq(packageDependencies.packageId, id));

  return dbRowToLoadedFlow({
    id: pkgRow.id,
    manifest: pkgRow.manifest,
    content: pkgRow.content ?? "",
    source: pkgRow.source,
    depRefs,
  });
}

/** List all flows: built-in (from cache) + user packages of type "flow" (from DB, scoped by org). */
export async function listPackages(orgId?: string): Promise<LoadedFlow[]> {
  const conditions = [eq(packages.type, "flow")];
  if (orgId) {
    conditions.push(eq(packages.orgId, orgId));
  }
  const rows = await db
    .select({
      id: packages.id,
      manifest: packages.manifest,
      content: packages.content,
      source: packages.source,
    })
    .from(packages)
    .where(and(...conditions));

  const userFlows = rows.map((row) =>
    dbRowToLoadedFlow({
      id: row.id,
      manifest: row.manifest,
      content: row.content ?? "",
      source: row.source,
    }),
  );

  return [...builtInFlows.values(), ...userFlows];
}

/** Get all package IDs (built-in + user, scoped by org). Used for collision checks. */
export async function getAllPackageIds(orgId?: string, type?: string): Promise<string[]> {
  // Collect built-in IDs based on type filter
  const builtInIds: string[] = [];
  if (!type || type === "flow") {
    builtInIds.push(...builtInFlows.keys());
  }
  if (!type || type === "skill") {
    builtInIds.push(...getBuiltInSkills().keys());
  }
  if (!type || type === "extension") {
    builtInIds.push(...getBuiltInExtensions().keys());
  }

  const conditions = [];
  if (orgId) {
    conditions.push(eq(packages.orgId, orgId));
  }
  if (type) {
    conditions.push(eq(packages.type, type as "flow" | "skill" | "extension"));
  }
  const rows = await db
    .select({ id: packages.id })
    .from(packages)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const userIds = rows.map((r) => r.id);
  return [...builtInIds, ...userIds];
}

/** Check if a package exists (built-in or user). */
export async function packageExists(id: string): Promise<boolean> {
  if (builtInFlows.has(id)) return true;
  const rows = await db.select({ cnt: count() }).from(packages).where(eq(packages.id, id));
  return (rows[0]?.cnt ?? 0) > 0;
}

/** Check if a package ID is a built-in flow. */
export function isBuiltInFlow(id: string): boolean {
  return builtInFlows.has(id);
}

/** Get the count of built-in flows loaded at boot. */
export function getBuiltInPackageCount(): number {
  return builtInFlows.size;
}
