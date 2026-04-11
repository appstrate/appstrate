// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helper: discover built-in modules and collect their OpenAPI
 * contributions (paths, component schemas, Zod schema registry entries).
 *
 * Used by both `scripts/verify-openapi.ts` and `scripts/detect-breaking-changes.ts`
 * so discovery stays in one place and both scripts see the same view of module
 * contributions without booting the platform.
 *
 * We scan `apps/api/src/modules/*​/index.ts` directly rather than going through
 * the module loader because the loader requires a full init context (DB, Redis,
 * etc.) that build-time scripts don't have.
 */
import { readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { AppstrateModule, OpenApiSchemaEntry } from "@appstrate/core/module";

export interface CollectedModuleOpenApi {
  /** OpenAPI 3.1 path items, keyed by path string. */
  paths: Record<string, unknown>;
  /** OpenAPI 3.1 component schemas, keyed by schema name. */
  componentSchemas: Record<string, unknown>;
  /** OpenAPI 3.1 tags contributed by modules. */
  tags: Array<{ name: string; description?: string }>;
  /** Zod ↔ OpenAPI registry entries for request-body schema comparison. */
  schemas: OpenApiSchemaEntry[];
  /** Set of path keys owned by any loaded module (for filtering). */
  ownedPathKeys: Set<string>;
  /** Set of component schema names owned by any loaded module (for filtering). */
  ownedSchemaNames: Set<string>;
  /** Set of tag names owned by any loaded module (for filtering). */
  ownedTagNames: Set<string>;
}

/**
 * Scan `apps/api/src/modules/*​/index.ts` and return the merged OpenAPI
 * contributions of every discovered module.
 */
export async function collectModuleOpenApi(): Promise<CollectedModuleOpenApi> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modulesDir = resolve(scriptDir, "../../apps/api/src/modules");

  const discoveredModules: string[] = existsSync(modulesDir)
    ? readdirSync(modulesDir).filter((name) => {
        const subdir = join(modulesDir, name);
        try {
          return statSync(subdir).isDirectory() && existsSync(join(subdir, "index.ts"));
        } catch {
          return false;
        }
      })
    : [];

  const paths: Record<string, unknown> = {};
  const componentSchemas: Record<string, unknown> = {};
  const tags: Array<{ name: string; description?: string }> = [];
  const schemas: OpenApiSchemaEntry[] = [];
  const ownedPathKeys = new Set<string>();
  const ownedSchemaNames = new Set<string>();
  const ownedTagNames = new Set<string>();

  for (const name of discoveredModules) {
    const entry = join(modulesDir, name, "index.ts");
    const mod: AppstrateModule = (await import(entry)).default;
    const modPaths = mod.openApiPaths?.();
    if (modPaths) {
      for (const key of Object.keys(modPaths)) ownedPathKeys.add(key);
      Object.assign(paths, modPaths);
    }
    const compSchemas = mod.openApiComponentSchemas?.();
    if (compSchemas) {
      for (const key of Object.keys(compSchemas)) ownedSchemaNames.add(key);
      Object.assign(componentSchemas, compSchemas);
    }
    const modTags = mod.openApiTags?.();
    if (modTags) {
      for (const tag of modTags) {
        ownedTagNames.add(tag.name);
        tags.push(tag);
      }
    }
    const modSchemas = mod.openApiSchemas?.();
    if (modSchemas) schemas.push(...modSchemas);
  }

  return {
    paths,
    componentSchemas,
    tags,
    schemas,
    ownedPathKeys,
    ownedSchemaNames,
    ownedTagNames,
  };
}

/** Minimal OpenAPI shape touched by the strip helper. */
type SpecWithContributions = {
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> } & Record<string, unknown>;
  tags?: Array<{ name: string; description?: string }>;
};

/**
 * Return a shallow copy of an OpenAPI spec with all module-owned contributions
 * removed: paths, component schemas, and tags. Used by `detect-breaking-changes.ts`
 * to keep the baseline comparison agnostic of modules — disabling a module should
 * not register as a breaking change, and an older baseline that still contains
 * module contributions should not produce a false diff either.
 */
export function stripModuleContributions<T extends SpecWithContributions>(
  spec: T,
  owned: {
    paths: ReadonlySet<string>;
    schemaNames: ReadonlySet<string>;
    tagNames: ReadonlySet<string>;
  },
): T {
  const out: T = { ...spec };

  if (spec.paths && owned.paths.size > 0) {
    const filteredPaths: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(spec.paths)) {
      if (!owned.paths.has(key)) filteredPaths[key] = value;
    }
    out.paths = filteredPaths;
  }

  if (spec.components?.schemas && owned.schemaNames.size > 0) {
    const filteredSchemas: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(spec.components.schemas)) {
      if (!owned.schemaNames.has(key)) filteredSchemas[key] = value;
    }
    out.components = { ...spec.components, schemas: filteredSchemas };
  }

  if (Array.isArray(spec.tags) && owned.tagNames.size > 0) {
    out.tags = spec.tags.filter((tag) => !owned.tagNames.has(tag.name));
  }

  return out;
}
