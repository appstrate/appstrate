import { eq, and } from "drizzle-orm";
import type { PublishResult } from "@appstrate/registry-client";
import { zipArtifact, type Zippable } from "@appstrate/validation/zip";
import { db } from "../lib/db.ts";
import { packages } from "@appstrate/db/schema";
import type { Package } from "@appstrate/db/schema";
import type { Manifest } from "@appstrate/validation";
import { getAuthenticatedRegistryClient } from "./registry-auth.ts";
import {
  getFlowItemFiles,
  downloadLibraryPackage,
  SKILL_CONFIG,
  EXTENSION_CONFIG,
} from "./library/index.ts";
import {
  isBuiltInSkill,
  isBuiltInExtension,
  getBuiltInSkillFiles,
  getBuiltInExtensionFile,
} from "./builtin-library.ts";
import { parseScopedName } from "@appstrate/validation/naming";
import { getPackage } from "./flow-service.ts";
import { buildRegistryDependencies } from "./library/dependencies.ts";
import { logger } from "../lib/logger.ts";

const ZIP_COMPRESSION_LEVEL = 6;

interface PublishOptions {
  version: string;
  scope?: string; // registry scope (without @), e.g. "pierre"
  name?: string; // registry name, e.g. "my-flow"
}

export async function publishPackage(
  packageId: string,
  orgId: string,
  userId: string,
  opts: PublishOptions,
): Promise<PublishResult> {
  // 1. Verify registry connection
  const client = await getAuthenticatedRegistryClient(userId);
  if (!client) {
    throw new Error("Not connected to registry");
  }

  // 2. Load package from DB
  const [pkg] = await db
    .select()
    .from(packages)
    .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)))
    .limit(1);

  if (!pkg) {
    throw new Error(`Package '${packageId}' not found`);
  }

  if (pkg.source === "built-in") {
    throw new Error("Cannot publish built-in packages");
  }

  // 3. Resolve registry scope/name via fallback chain:
  //    1. opts.scope/opts.name (explicit from publish form)
  //    2. pkg.registryScope/pkg.registryName (previously published)
  //    3. Parse from manifest.name (last resort)
  const currentManifest = (pkg.manifest ?? {}) as Partial<Manifest>;
  const parsed = parseScopedName(currentManifest.name!);
  if (!parsed) {
    throw new Error("manifest.name must be in @scope/name format");
  }

  const scope = opts.scope || pkg.registryScope || parsed.scope;
  const name = opts.name || pkg.registryName || parsed.name;

  // 4. Build publish manifest — local manifest stays untouched,
  //    only the ZIP sent to registry uses registry scope/name
  const publishManifest: Partial<Manifest> = {
    ...currentManifest,
    name: `@${scope}/${name}`,
    version: opts.version,
  };

  // 5. Compute registryDependencies fresh from junction table
  const registryDeps = await buildRegistryDependencies(packageId, orgId);
  if (registryDeps) publishManifest.registryDependencies = registryDeps;
  else delete publishManifest.registryDependencies;

  // 6. Build artifact
  const artifact = await buildPublishableArtifact(pkg, orgId, publishManifest);

  // 7. Publish to registry
  const result = await client.publish(artifact);

  // 8. Update local package with registry tracking — local manifest stays intact
  await db
    .update(packages)
    .set({
      registryScope: scope,
      registryName: name,
      lastPublishedVersion: opts.version,
      lastPublishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(packages.id, packageId));

  logger.info("Package published to registry", {
    packageId,
    scope,
    name,
    version: opts.version,
  });

  return result;
}

async function buildPublishableArtifact(
  pkg: Package,
  orgId: string,
  manifest: Partial<Manifest>,
): Promise<Uint8Array> {
  const entries: Zippable = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  };

  if (pkg.type === "flow") {
    // Flow: manifest + prompt + skills + extensions
    const flow = await getPackage(pkg.id, orgId);
    if (flow) {
      entries["prompt.md"] = new TextEncoder().encode(flow.prompt);

      // Fetch org skill files and extension files in parallel
      const [skillFiles, extFiles] = await Promise.all([
        getFlowItemFiles(pkg.id, orgId, SKILL_CONFIG),
        getFlowItemFiles(pkg.id, orgId, EXTENSION_CONFIG),
      ]);

      for (const [skillId, files] of skillFiles) {
        for (const [filePath, content] of Object.entries(files)) {
          entries[`skills/${skillId}/${filePath}`] = content;
        }
      }

      for (const [, files] of extFiles) {
        for (const [filePath, content] of Object.entries(files)) {
          entries[`extensions/${filePath}`] = content;
        }
      }

      // Add built-in skills and extensions referenced by the flow
      const builtInSkillPromises = flow.skills
        .filter((s) => isBuiltInSkill(s.id) && !skillFiles.has(s.id))
        .map(async (s) => {
          const files = await getBuiltInSkillFiles(s.id);
          if (files) {
            for (const [filePath, content] of Object.entries(files)) {
              entries[`skills/${s.id}/${filePath}`] = content;
            }
          }
        });

      const orgExtIds = new Set([...extFiles.keys()]);
      const builtInExtPromises = flow.extensions
        .filter((e) => isBuiltInExtension(e.id) && !orgExtIds.has(e.id))
        .map(async (e) => {
          const file = await getBuiltInExtensionFile(e.id);
          if (file) {
            const slug = parseScopedName(e.id)?.name ?? e.id;
            entries[`extensions/${slug}.ts`] = file;
          }
        });

      await Promise.all([...builtInSkillPromises, ...builtInExtPromises]);
    }
  } else if (pkg.type === "skill") {
    // Skill: manifest + files from storage (or content as SKILL.md)
    const files = await downloadLibraryPackage("skills", orgId, pkg.id);
    if (files) {
      for (const [filePath, content] of Object.entries(files)) {
        entries[filePath] = content;
      }
    } else if (pkg.content) {
      entries["SKILL.md"] = new TextEncoder().encode(pkg.content);
    }
  } else if (pkg.type === "extension") {
    // Extension: manifest + .ts file from storage (or content)
    const files = await downloadLibraryPackage("extensions", orgId, pkg.id);
    if (files) {
      for (const [filePath, content] of Object.entries(files)) {
        entries[filePath] = content;
      }
    } else if (pkg.content) {
      entries[`${pkg.id}.ts`] = new TextEncoder().encode(pkg.content);
    }
  }

  return zipArtifact(entries, ZIP_COMPRESSION_LEVEL);
}
