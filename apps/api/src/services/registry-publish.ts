import { eq, and } from "drizzle-orm";
import { RegistryClientError, type PublishResult } from "@appstrate/registry-client";
import { zipArtifact, unzipArtifact, type Zippable } from "@appstrate/core/zip";
import { db } from "../lib/db.ts";
import { packages, packageVersions } from "@appstrate/db/schema";
import type { Package } from "@appstrate/db/schema";
import type { Manifest } from "@appstrate/core/validation";
import { getAuthenticatedRegistryClient } from "./registry-auth.ts";
import {
  getFlowItemFiles,
  downloadPackageFiles,
  SKILL_CONFIG,
  EXTENSION_CONFIG,
} from "./package-items/index.ts";
import {
  isBuiltInSkill,
  isBuiltInExtension,
  getBuiltInSkillFiles,
  getBuiltInExtensionFile,
} from "./builtin-packages.ts";
import { parseScopedName } from "@appstrate/core/naming";
import { isValidVersion } from "@appstrate/core/semver";
import { validateForwardVersion } from "@appstrate/core/version-policy";
import { prepareManifestForPublish } from "@appstrate/core/publish-manifest";
import { getPackage } from "./flow-service.ts";
import { buildRegistryDependencies } from "./package-items/dependencies.ts";
import { downloadVersionZip } from "./package-storage.ts";
import { logger } from "../lib/logger.ts";

const ZIP_COMPRESSION_LEVEL = 6;

export class PublishValidationError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "PublishValidationError";
  }
}

export async function publishPackage(
  packageId: string,
  orgId: string,
  userId: string,
  targetVersion?: string,
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

  // 3. Resolve manifest: from a specific version or from the draft
  let sourceManifest: Partial<Manifest>;
  let versionZipBuffer: Buffer | null = null;

  if (targetVersion) {
    // Load from packageVersions table
    const [versionRow] = await db
      .select()
      .from(packageVersions)
      .where(
        and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, targetVersion)),
      )
      .limit(1);

    if (!versionRow) {
      throw new PublishValidationError(
        "VERSION_NOT_FOUND",
        `Version "${targetVersion}" not found for package "${packageId}"`,
      );
    }

    if (versionRow.yanked) {
      throw new PublishValidationError(
        "VERSION_YANKED",
        `Version "${targetVersion}" has been yanked and cannot be published`,
      );
    }

    sourceManifest = (versionRow.manifest ?? {}) as Partial<Manifest>;
    versionZipBuffer = await downloadVersionZip(packageId, targetVersion, versionRow.integrity);

    if (!versionZipBuffer) {
      throw new PublishValidationError(
        "VERSION_ZIP_MISSING",
        `ZIP artifact not found for version "${targetVersion}"`,
      );
    }
  } else {
    sourceManifest = (pkg.manifest ?? {}) as Partial<Manifest>;
  }

  // 4. Derive scope/name from manifest (single source of truth)
  const parsed = parseScopedName(sourceManifest.name!);
  if (!parsed) {
    throw new Error("manifest.name must be in @scope/name format");
  }

  const { scope, name } = parsed;

  // 5. Version comes from manifest (user-controlled, npm model)
  const version = sourceManifest.version as string | undefined;

  if (!version) {
    throw new PublishValidationError("VERSION_MISSING", "manifest.version is required");
  }
  if (!isValidVersion(version)) {
    throw new PublishValidationError("VERSION_INVALID", `"${version}" is not valid semver (X.Y.Z)`);
  }

  // Forward-only enforcement using core helper
  const publishedVersions = pkg.lastPublishedVersion ? [pkg.lastPublishedVersion] : [];
  const forwardCheck = validateForwardVersion(version, publishedVersions);
  if (!forwardCheck.ok) {
    throw new PublishValidationError(
      forwardCheck.error === "VERSION_EXISTS" ? "VERSION_EXISTS" : "VERSION_NOT_HIGHER",
      `Version "${version}" must be greater than last published "${forwardCheck.highest ?? pkg.lastPublishedVersion}"`,
    );
  }

  // 6. Build publish manifest with registry deps — local manifest stays untouched
  const registryDeps = await buildRegistryDependencies(packageId, orgId);
  const publishManifest = prepareManifestForPublish(
    sourceManifest as Record<string, unknown>,
    scope,
    name,
    version,
    registryDeps,
  ) as Partial<Manifest>;

  // 7. Build artifact
  const artifact = versionZipBuffer
    ? await buildArtifactFromVersionZip(versionZipBuffer, publishManifest)
    : await buildPublishableArtifact(pkg, orgId, publishManifest);

  // 8. Publish to registry
  let result: PublishResult;
  try {
    result = await client.publish(artifact);
  } catch (err) {
    if (err instanceof RegistryClientError) {
      throw new PublishValidationError(
        err.status === 409 ? "REGISTRY_CONFLICT" : err.code,
        err.message,
        err.status >= 400 && err.status < 500 ? err.status : 502,
      );
    }
    throw err;
  }

  // 9. Update local package with registry tracking — local manifest stays intact
  await db
    .update(packages)
    .set({
      lastPublishedVersion: version,
      lastPublishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(packages.id, packageId));

  logger.info("Package published to registry", {
    packageId,
    scope,
    name,
    version,
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
    const files = await downloadPackageFiles("skills", orgId, pkg.id);
    if (files) {
      for (const [filePath, content] of Object.entries(files)) {
        entries[filePath] = content;
      }
    } else if (pkg.content) {
      entries["SKILL.md"] = new TextEncoder().encode(pkg.content);
    }
  } else if (pkg.type === "extension") {
    // Extension: manifest + .ts file from storage (or content)
    const files = await downloadPackageFiles("extensions", orgId, pkg.id);
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

/** Build a publishable artifact from a stored version ZIP, replacing manifest.json with the publish manifest. */
async function buildArtifactFromVersionZip(
  zipBuffer: Buffer,
  publishManifest: Partial<Manifest>,
): Promise<Uint8Array> {
  const files = unzipArtifact(new Uint8Array(zipBuffer));
  const entries: Zippable = {};

  // Copy all files from the version ZIP except manifest.json
  for (const [filePath, content] of Object.entries(files)) {
    if (filePath === "manifest.json") continue;
    entries[filePath] = content;
  }

  // Replace manifest with the publish manifest
  entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(publishManifest, null, 2));

  return zipArtifact(entries, ZIP_COMPRESSION_LEVEL);
}
