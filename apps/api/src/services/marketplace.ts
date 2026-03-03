import { RegistryClient } from "@appstrate/registry-client";
import {
  getRegistryClient,
  isRegistryConfigured,
  getRegistryDiscovery,
} from "./registry-provider.ts";
import { db } from "../lib/db.ts";
import { packages } from "@appstrate/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { getEnv } from "@appstrate/env";
import { parsePackageZip, PackageZipError } from "@appstrate/core/zip";
import { normalizeScope, buildPackageId, parseScopedName } from "@appstrate/core/naming";
import { extractDependencies } from "@appstrate/core/dependencies";
import { resolveLatestVersion } from "@appstrate/core/semver";
import { checkUpdateAvailable } from "@appstrate/core/update-check";
import { postInstallPackage } from "./post-install-package.ts";
import { getLatestVersionId } from "./package-versions.ts";
import { packageVersions } from "@appstrate/db/schema";
import type { Manifest } from "@appstrate/core/validation";

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

async function findMissingDependencies(
  manifest: Partial<Manifest>,
  orgId: string,
): Promise<{ scope: string; name: string; type: string; versionRange: string }[]> {
  const deps = extractDependencies(manifest);
  if (deps.length === 0) return [];

  const expectedIds = deps.map((d) => buildPackageId(d.depScope, d.depName));

  const existing = await db
    .select({ id: packages.id })
    .from(packages)
    .where(and(eq(packages.orgId, orgId), inArray(packages.id, expectedIds)));

  const existingSet = new Set(existing.map((e) => e.id));

  return deps
    .filter((d) => !existingSet.has(buildPackageId(d.depScope, d.depName)))
    .map((d) => ({
      scope: d.depScope,
      name: d.depName,
      type: d.depType,
      versionRange: d.versionRange,
    }));
}

// --- Install ---

const MAX_INSTALL_PACKAGES = 10;

export interface InstallResult {
  packageId: string;
  type: string;
  version: string | null;
  autoInstalledDeps?: { packageId: string; type: string; version: string | null }[];
}

interface CollectedPackage {
  packageId: string;
  scope: string;
  name: string;
  version: string;
  type: "flow" | "skill" | "extension";
  manifest: Record<string, unknown>;
  content: string;
  files: Record<string, Uint8Array>;
  artifactData: Uint8Array;
  integrity: string;
  autoInstalled: boolean;
}

interface CollectContext {
  autoInstalled: boolean;
  visited: Set<string>;
  collected: CollectedPackage[];
}

/**
 * Phase A — Collect all packages (network + DB reads, no writes).
 * Recursively resolves missing dependencies.
 */
async function collectPackages(
  rawScope: string,
  name: string,
  version: string | undefined,
  orgId: string,
  accessToken: string | undefined,
  ctx: CollectContext,
): Promise<void> {
  if (ctx.collected.length >= MAX_INSTALL_PACKAGES) {
    throw new Error(`Install aborted: dependency tree exceeds ${MAX_INSTALL_PACKAGES} packages`);
  }

  const scope = normalizeScope(rawScope);
  const packageId = buildPackageId(scope, name);

  // Diamond dedup — already collected
  if (ctx.collected.some((p) => p.packageId === packageId)) return;

  // Cycle detection
  if (ctx.visited.has(packageId)) {
    logger.warn("Circular dependency detected, skipping", { depId: packageId });
    return;
  }

  const env = getEnv();
  const client = new RegistryClient({ baseUrl: env.REGISTRY_URL!, accessToken });

  // Get package info from registry
  const pkg = await client.getPackage(scope, name);
  if (!pkg) {
    throw new Error(`Package ${scope}/${name} not found in registry`);
  }

  // Resolve target version using shared logic
  const latestVersion = resolveLatestVersion(
    pkg.versions.map((v) => ({ id: v.id, version: v.version })),
    pkg.distTags?.map((t) => ({ tag: t.tag, versionId: t.versionId })) ?? [],
  );
  const targetVersion = version ?? latestVersion;
  if (!targetVersion) {
    throw new Error(`No version available for ${scope}/${name}`);
  }

  // Download artifact ZIP with integrity verification
  logger.info("Downloading artifact", { scope, name, version: targetVersion });
  const {
    data: artifactData,
    integrity,
    verified,
  } = await client.downloadArtifact(scope, name, targetVersion, { verifyIntegrity: true });
  logger.info("Artifact downloaded", { size: artifactData.length, integrity, verified });

  // Verify integrity (mandatory)
  if (!integrity) {
    throw new Error(`Integrity header missing for ${scope}/${name}@${targetVersion}`);
  }
  if (!verified) {
    throw new Error(
      `Integrity check failed for ${scope}/${name}@${targetVersion}: expected ${integrity}`,
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

  // Collect deps first (recursive)
  const missingDeps = await findMissingDependencies(manifest as Partial<Manifest>, orgId);
  for (const dep of missingDeps) {
    await collectPackages(dep.scope, dep.name, undefined, orgId, accessToken, {
      autoInstalled: true,
      visited: new Set([...ctx.visited, packageId]),
      collected: ctx.collected,
    });
  }

  ctx.collected.push({
    packageId,
    scope,
    name,
    version: targetVersion,
    type: packageType,
    manifest: manifest as Record<string, unknown>,
    content,
    files,
    artifactData: new Uint8Array(artifactData),
    integrity,
    autoInstalled: ctx.autoInstalled,
  });
}

/**
 * Phase B — Commit all collected packages in a single DB transaction.
 * Uses pg_advisory_xact_lock for per-package concurrency safety.
 */
async function commitPackages(
  collected: CollectedPackage[],
  orgId: string,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const pkg of collected) {
      // Advisory lock scoped to this transaction (auto-released on commit/rollback)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pkg.packageId}))`);

      const [existing] = await tx
        .select({ id: packages.id })
        .from(packages)
        .where(and(eq(packages.id, pkg.packageId), eq(packages.orgId, orgId)))
        .limit(1);

      if (existing) {
        // Update existing — promote auto→explicit, never demote explicit→auto
        await tx
          .update(packages)
          .set({
            manifest: pkg.manifest,
            content: pkg.content,
            updatedAt: new Date(),
            ...(!pkg.autoInstalled && { autoInstalled: false }),
          })
          .where(and(eq(packages.id, pkg.packageId), eq(packages.orgId, orgId)));
      } else {
        await tx.insert(packages).values({
          id: pkg.packageId,
          orgId,
          type: pkg.type,
          source: "local",
          name: `${pkg.scope}/${pkg.name}`,
          manifest: pkg.manifest,
          content: pkg.content,
          autoInstalled: pkg.autoInstalled,
          createdBy: userId,
          updatedAt: new Date(),
        });
      }
    }
  });
}

export async function installFromMarketplace(
  rawScope: string,
  name: string,
  version: string | undefined,
  orgId: string,
  userId: string,
  accessToken: string | undefined,
): Promise<InstallResult> {
  // Phase A — collect (network + DB reads, no writes)
  const ctx: CollectContext = {
    autoInstalled: false,
    visited: new Set<string>(),
    collected: [],
  };
  await collectPackages(rawScope, name, version, orgId, accessToken, ctx);

  // Phase B — commit (single DB transaction)
  await commitPackages(ctx.collected, orgId, userId);

  // Phase C — post-install (storage + versions, outside transaction)
  for (const pkg of ctx.collected) {
    await postInstallPackage({
      packageType: pkg.type,
      packageId: pkg.packageId,
      orgId,
      userId,
      content: pkg.content,
      files: pkg.files,
      zipBuffer: Buffer.from(pkg.artifactData),
      version: pkg.version,
    });
  }

  const root = ctx.collected[ctx.collected.length - 1]!;
  const deps = ctx.collected
    .filter((p) => p.autoInstalled)
    .map((p) => ({ packageId: p.packageId, type: p.type, version: p.version }));

  logger.info("Installed package from marketplace", {
    packageId: root.packageId,
    type: root.type,
    version: root.version,
    orgId,
    depsInstalled: deps.length,
  });

  return {
    packageId: root.packageId,
    type: root.type,
    version: root.version,
    ...(deps.length > 0 ? { autoInstalledDeps: deps } : {}),
  };
}

// --- Installed version resolution ---

/** Resolve installed version: dist-tag → version row → manifest fallback. */
async function resolveInstalledVersion(
  packageId: string,
  orgId: string,
  cachedManifest?: Record<string, unknown> | null,
): Promise<string | null> {
  const latestVersionId = await getLatestVersionId(packageId);
  if (latestVersionId) {
    const [ver] = await db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.id, latestVersionId))
      .limit(1);
    if (ver?.version) return ver.version;
  }
  // Fallback to manifest if no version row exists (pre-migration packages)
  if (cachedManifest !== undefined) {
    return (((cachedManifest ?? {}) as Partial<Manifest>).version as string) ?? null;
  }
  const [row] = await db
    .select({ manifest: packages.manifest })
    .from(packages)
    .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)))
    .limit(1);
  return (((row?.manifest ?? {}) as Partial<Manifest>).version as string) ?? null;
}

// --- Package detail with install status ---

export async function getMarketplacePackageWithInstallStatus(
  rawScope: string,
  name: string,
  orgId: string,
  accessToken?: string,
) {
  const pkg = await getMarketplacePackage(rawScope, name, accessToken);
  if (!pkg) return null;

  const scope = normalizeScope(rawScope);
  const packageId = buildPackageId(scope, name);

  const [installed] = await db
    .select({ id: packages.id })
    .from(packages)
    .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)))
    .limit(1);

  const installedVersion = installed ? await resolveInstalledVersion(packageId, orgId) : null;

  return {
    ...pkg,
    installedVersion,
  };
}

// --- Installed registry packages ---

export async function getInstalledRegistryPackages(orgId: string) {
  const rows = await db
    .select({
      id: packages.id,
      type: packages.type,
      manifest: packages.manifest,
      updatedAt: packages.updatedAt,
    })
    .from(packages)
    .where(eq(packages.orgId, orgId));

  return rows.map((row) => {
    const parsed = parseScopedName(row.id);
    return {
      ...row,
      registryScope: parsed?.scope ?? null,
      registryName: parsed?.name ?? null,
    };
  });
}

// --- Check for updates ---

export interface PackageUpdateStatus {
  id: string;
  type: string;
  scope: string;
  name: string;
  displayName: string | null;
  installedVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}

export async function checkRegistryUpdates(
  orgId: string,
  accessToken?: string,
): Promise<PackageUpdateStatus[]> {
  const installed = await getInstalledRegistryPackages(orgId);
  if (installed.length === 0) return [];

  const client = getRegistryClient();
  if (!client) return [];

  const authedClient = accessToken
    ? new RegistryClient({ baseUrl: getEnv().REGISTRY_URL!, accessToken })
    : client;

  const results = await Promise.allSettled(
    installed.map(async (pkg): Promise<PackageUpdateStatus | null> => {
      const parsed = parseScopedName(pkg.id);
      if (!parsed) return null;

      let remote;
      try {
        remote = await authedClient.getPackage(`@${parsed.scope}`, parsed.name);
      } catch {
        return null;
      }
      if (!remote) return null;

      // Read installed version from packageVersions via dist-tag, fallback to manifest
      const installedVersion = await resolveInstalledVersion(
        pkg.id,
        orgId,
        pkg.manifest as Record<string, unknown> | null,
      );

      // Use shared update check logic — fixes the bug of using !== instead of semver comparison
      const { latestVersion, updateAvailable } = checkUpdateAvailable({
        installedVersion,
        remoteVersions: remote.versions.map((v) => ({ id: v.id, version: v.version })),
        remoteDistTags: remote.distTags?.map((t) => ({ tag: t.tag, versionId: t.versionId })) ?? [],
      });

      const manifest = (pkg.manifest ?? {}) as Partial<Manifest>;
      return {
        id: pkg.id,
        type: pkg.type,
        scope: parsed.scope,
        name: parsed.name,
        displayName: manifest.displayName ?? null,
        // "0.0.0" ensures any registry version satisfies the update check
        installedVersion: installedVersion ?? "0.0.0",
        latestVersion,
        updateAvailable,
      };
    }),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<PackageUpdateStatus> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value);
}
