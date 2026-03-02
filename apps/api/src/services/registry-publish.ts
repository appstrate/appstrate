import { eq, and } from "drizzle-orm";
import type { PublishResult } from "@appstrate/registry-client";
import { zipArtifact, type Zippable } from "@appstrate/validation/zip";
import { db } from "../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import type { Package } from "@appstrate/db/schema";
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
import { logger } from "../lib/logger.ts";

const ZIP_COMPRESSION_LEVEL = 6;

interface PublishOptions {
  scope?: string;
  name?: string;
  version: string;
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

  // 3. Resolve scope and name from the manifest (already in @scope/name format)
  const existingName = (pkg.manifest as Record<string, unknown>).name as string;
  const parsed = parseScopedName(existingName);
  const scope = opts.scope
    ? opts.scope.startsWith("@")
      ? opts.scope.slice(1)
      : opts.scope
    : parsed?.scope || pkg.registryScope;
  const name = opts.name || parsed?.name || pkg.registryName || packageId;
  if (!scope) {
    throw new Error("Publish scope is required");
  }

  // 4. Build manifest — manifest already has name/type, only override version (and name if changed)
  const manifest: Record<string, unknown> = {
    ...(pkg.manifest as Record<string, unknown>),
    version: opts.version,
  };
  // Override name only if the publish scope/name differs from the manifest
  if (`@${scope}/${name}` !== existingName) {
    manifest.name = `@${scope}/${name}`;
  }

  // 5. Add registryDependencies for flows
  if (pkg.type === "flow") {
    const registryDeps = await resolveRegistryDeps(packageId, orgId);
    if (registryDeps) {
      manifest.registryDependencies = registryDeps;
    }
  }

  // 6. Build artifact
  const artifact = await buildPublishableArtifact(pkg, orgId, manifest);

  // 7. Publish to registry
  const result = await client.publish(artifact);

  // 8. Update local package with registry identity
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
  manifest: Record<string, unknown>,
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
            entries[`extensions/${e.id}.ts`] = file;
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

async function resolveRegistryDeps(
  packageId: string,
  orgId: string,
): Promise<Record<string, Record<string, string>> | null> {
  const deps = await db
    .select({
      dependencyId: packageDependencies.dependencyId,
      type: packages.type,
      registryScope: packages.registryScope,
      registryName: packages.registryName,
      lastPublishedVersion: packages.lastPublishedVersion,
    })
    .from(packageDependencies)
    .innerJoin(packages, eq(packages.id, packageDependencies.dependencyId))
    .where(and(eq(packageDependencies.packageId, packageId), eq(packageDependencies.orgId, orgId)));

  const skills: Record<string, string> = {};
  const extensions: Record<string, string> = {};

  for (const dep of deps) {
    if (!dep.registryScope || !dep.registryName) continue;
    const scopedName = `@${dep.registryScope}/${dep.registryName}`;
    const version = dep.lastPublishedVersion || "*";

    if (dep.type === "skill") {
      skills[scopedName] = version;
    } else if (dep.type === "extension") {
      extensions[scopedName] = version;
    }
  }

  const hasSkills = Object.keys(skills).length > 0;
  const hasExtensions = Object.keys(extensions).length > 0;
  if (!hasSkills && !hasExtensions) return null;

  const result: Record<string, Record<string, string>> = {};
  if (hasSkills) result.skills = skills;
  if (hasExtensions) result.extensions = extensions;
  return result;
}
