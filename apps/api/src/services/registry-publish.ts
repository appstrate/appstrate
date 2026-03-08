import { eq, and } from "drizzle-orm";
import { RegistryClientError, type PublishResult } from "@appstrate/registry-client";
import { db } from "../lib/db.ts";
import { packages, packageVersions } from "@appstrate/db/schema";
import type { Manifest } from "@appstrate/core/validation";
import { getAuthenticatedRegistryClient } from "./registry-auth.ts";
import { getRegistryClient } from "./registry-provider.ts";
import { parseScopedName } from "@appstrate/core/naming";
import { isValidVersion } from "@appstrate/core/semver";
import { validateForwardVersion } from "@appstrate/core/version-policy";
import { downloadVersionZip } from "./package-storage.ts";
import { logger } from "../lib/logger.ts";

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

  if (pkg.source === "built-in" || pkg.source === "system") {
    throw new Error("Cannot publish built-in packages");
  }

  // 3. A version is required — draft publish is no longer supported
  if (!targetVersion) {
    throw new PublishValidationError(
      "VERSION_REQUIRED",
      "A version must be created before publishing. Create a version first, then publish it.",
    );
  }

  // 4. Load the version row
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

  const sourceManifest = (versionRow.manifest ?? {}) as Partial<Manifest>;
  const versionZipBuffer = await downloadVersionZip(packageId, targetVersion, versionRow.integrity);

  if (!versionZipBuffer) {
    throw new PublishValidationError(
      "VERSION_ZIP_MISSING",
      `ZIP artifact not found for version "${targetVersion}"`,
    );
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

  // Forward-only enforcement — query registry for published versions (source of truth)
  let publishedVersions: string[] = [];
  try {
    const registryClient = getRegistryClient();
    if (registryClient) {
      const detail = await registryClient.getPackage(`@${scope}`, name);
      publishedVersions = detail.versions
        .filter((v: { yanked?: boolean }) => !v.yanked)
        .map((v: { version: string }) => v.version);
    }
  } catch {
    // Package not on registry yet — no published versions
  }
  const forwardCheck = validateForwardVersion(version, publishedVersions);
  if (!forwardCheck.ok) {
    throw new PublishValidationError(
      forwardCheck.error === "VERSION_EXISTS" ? "VERSION_EXISTS" : "VERSION_NOT_HIGHER",
      `Version "${version}" must be greater than last published "${forwardCheck.highest ?? ""}"`,
    );
  }

  // 6. Send version ZIP directly — it already contains the enriched manifest
  const artifact = new Uint8Array(versionZipBuffer);

  // 7. Publish to registry
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

  logger.info("Package published to registry", {
    packageId,
    scope,
    name,
    version,
  });

  return result;
}
