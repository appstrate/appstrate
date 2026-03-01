import { RegistryClient } from "@appstrate/registry-client";
import {
  getRegistryClient,
  isRegistryConfigured,
  getRegistryDiscovery,
} from "./registry-provider.ts";
import { db } from "../lib/db.ts";
import { packages } from "@appstrate/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { getEnv } from "@appstrate/env";
import { parsePackageZip, PackageZipError } from "@appstrate/validation/zip";
import { normalizeScope, depEntryToPackageId } from "@appstrate/validation/naming";
import { computeIntegrity } from "@appstrate/validation/integrity";
import { extractDependencies } from "@appstrate/validation/dependencies";
import { postInstallPackage } from "./library.ts";

// --- Status ---

export interface MarketplaceStatus {
  configured: boolean;
  registryUrl: string | null;
  connected: boolean;
  oauth?: {
    authorizationUrl: string;
    tokenUrl: string;
  };
}

export function getMarketplaceStatus(): MarketplaceStatus {
  const env = getEnv();
  const client = getRegistryClient();
  const discovery = getRegistryDiscovery();

  return {
    configured: isRegistryConfigured(),
    registryUrl: env.REGISTRY_URL ?? null,
    connected: !!client,
    ...(discovery?.oauth ? { oauth: discovery.oauth } : {}),
  };
}

// --- Search ---

export interface MarketplaceSearchOpts {
  q?: string;
  type?: "flow" | "skill" | "extension";
  sort?: "relevance" | "downloads" | "recent";
  page?: number;
  perPage?: number;
}

export async function searchMarketplace(opts: MarketplaceSearchOpts, accessToken?: string) {
  const client = getRegistryClient();
  if (!client) {
    throw new Error("Registry not configured or unavailable");
  }

  const authedClient = accessToken
    ? new RegistryClient({ baseUrl: getEnv().REGISTRY_URL!, accessToken })
    : client;

  return authedClient.search(opts);
}

// --- Package detail ---

export async function getMarketplacePackage(rawScope: string, name: string, accessToken?: string) {
  const client = getRegistryClient();
  if (!client) {
    throw new Error("Registry not configured or unavailable");
  }

  const scope = normalizeScope(rawScope);
  const authedClient = accessToken
    ? new RegistryClient({ baseUrl: getEnv().REGISTRY_URL!, accessToken })
    : client;

  return authedClient.getPackage(scope, name);
}

// --- Dependency validation ---

export class MissingDependencyError extends Error {
  public readonly missing: { scope: string; name: string; type: string; versionRange: string }[];

  constructor(missing: { scope: string; name: string; type: string; versionRange: string }[]) {
    const depList = missing
      .map((d) => `${d.scope}/${d.name} (${d.type}, ${d.versionRange})`)
      .join(", ");
    super(`Missing dependencies: ${depList}. Install them first.`);
    this.name = "MissingDependencyError";
    this.missing = missing;
  }
}

async function findMissingDependencies(
  manifest: Record<string, unknown>,
  orgId: string,
): Promise<{ scope: string; name: string; type: string; versionRange: string }[]> {
  const deps = extractDependencies(manifest);
  if (deps.length === 0) return [];

  const expectedIds = deps.map((d) => depEntryToPackageId(d.depScope, d.depName));

  const existing = await db
    .select({ id: packages.id })
    .from(packages)
    .where(and(eq(packages.orgId, orgId), inArray(packages.id, expectedIds)));

  const existingSet = new Set(existing.map((e) => e.id));

  return deps
    .filter((d) => !existingSet.has(depEntryToPackageId(d.depScope, d.depName)))
    .map((d) => ({
      scope: d.depScope,
      name: d.depName,
      type: d.depType,
      versionRange: d.versionRange,
    }));
}

// --- Install ---

export interface InstallResult {
  packageId: string;
  type: string;
  version: string | null;
}

export async function installFromMarketplace(
  rawScope: string,
  name: string,
  version: string | undefined,
  orgId: string,
  userId: string,
  accessToken: string | undefined,
): Promise<InstallResult> {
  const env = getEnv();
  const scope = normalizeScope(rawScope);
  const client = new RegistryClient({ baseUrl: env.REGISTRY_URL!, accessToken });

  // Get package info from registry
  const pkg = await client.getPackage(scope, name);
  if (!pkg) {
    throw new Error(`Package ${scope}/${name} not found in registry`);
  }

  const latestTag = pkg.distTags?.find((t: { tag: string }) => t.tag === "latest");
  const latestVersion = latestTag
    ? (pkg.versions.find((v: { id: number }) => v.id === latestTag.versionId)?.version ?? null)
    : (pkg.versions.at(-1)?.version ?? null);
  const targetVersion = version ?? latestVersion;
  if (!targetVersion) {
    throw new Error(`No version available for ${scope}/${name}`);
  }

  // Download artifact ZIP and extract manifest + content
  logger.info("Downloading artifact", { scope, name, version: targetVersion });
  const { data: artifactData, integrity } = await client.downloadArtifact(
    scope,
    name,
    targetVersion,
  );
  logger.info("Artifact downloaded", { size: artifactData.length, integrity });

  // Verify integrity (mandatory)
  if (!integrity) {
    throw new Error(`Integrity header missing for ${scope}/${name}@${targetVersion}`);
  }
  const computed = computeIntegrity(new Uint8Array(artifactData));
  if (computed !== integrity) {
    throw new Error(
      `Integrity check failed for ${scope}/${name}@${targetVersion}: expected ${integrity}, got ${computed}`,
    );
  }

  let parsed;
  try {
    parsed = parsePackageZip(new Uint8Array(artifactData));
  } catch (err) {
    if (err instanceof PackageZipError) {
      throw new Error(`Invalid package artifact: ${err.message}`, { cause: err });
    }
    throw err;
  }

  const { manifest, content, files, type: packageType } = parsed;
  logger.info("ZIP parsed", { type: packageType, contentLength: content.length });

  // Validate that registry dependencies are installed in the org
  const missingDeps = await findMissingDependencies(manifest as Record<string, unknown>, orgId);
  if (missingDeps.length > 0) {
    throw new MissingDependencyError(missingDeps);
  }

  const packageId = depEntryToPackageId(scope, name);
  const displayName = (manifest.displayName as string) ?? name;

  // Check if already installed
  const [existing] = await db
    .select({ id: packages.id })
    .from(packages)
    .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)))
    .limit(1);

  if (existing) {
    // Update existing
    await db
      .update(packages)
      .set({
        manifest,
        content,
        displayName,
        description: pkg.description ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)));
  } else {
    // Insert new
    await db.insert(packages).values({
      id: packageId,
      orgId,
      type: packageType,
      source: "local",
      name,
      manifest,
      content,
      displayName,
      description: pkg.description ?? null,
      createdBy: userId,
      updatedAt: new Date(),
    });
  }

  // Per-type post-install (version, library upsert, storage upload)
  await postInstallPackage({
    packageType,
    packageId,
    orgId,
    userId,
    content,
    files,
    zipBuffer: Buffer.from(artifactData),
  });

  logger.info("Installed package from marketplace", {
    packageId,
    scope,
    name,
    type: packageType,
    version: targetVersion,
    orgId,
  });

  return {
    packageId,
    type: packageType,
    version: targetVersion,
  };
}
