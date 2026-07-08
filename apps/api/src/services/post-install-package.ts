// SPDX-License-Identifier: Apache-2.0

import { parseManifestFromFiles } from "../lib/manifest-parser.ts";
import { createVersionAndUpload } from "./package-versions.ts";
import {
  createOrgItem,
  reinstallOrgItem,
  getOrgItem,
  type CreateItemInput,
} from "./package-items/crud.ts";
import { uploadPackageFiles } from "./package-items/storage.ts";
import { CONFIG_BY_TYPE, type PackageTypeConfig } from "./package-items/config.ts";
import { isValidVersion } from "@appstrate/core/semver";
import type { PackageType } from "@appstrate/core/validation";

/** Insert or update a skill during post-install. */
async function upsertItem(
  orgId: string,
  packageId: string,
  item: CreateItemInput,
  cfg: PackageTypeConfig,
  manifest: Record<string, unknown>,
): Promise<void> {
  const existing = await getOrgItem(orgId, packageId, cfg);
  if (existing && existing.lock_version != null) {
    // Re-install: overwrite the existing package. `reinstallOrgItem` re-reads
    // the current lock_version and retries on a concurrent bump (last-writer-
    // wins), so the install is never silently dropped on an optimistic-lock
    // mismatch — the previous `updateOrgItem(existing.lock_version)` ignored a
    // null return and no-op'd when another writer touched the row first. A null
    // here means the row vanished mid-reinstall → fall back to insert.
    const updated = await reinstallOrgItem(orgId, packageId, { manifest, content: item.content });
    if (!updated) {
      await createOrgItem(orgId, item, cfg, manifest);
    }
  } else {
    await createOrgItem(orgId, item, cfg, manifest);
  }
}

/**
 * Run per-type post-install side-effects after a package is saved to the DB.
 * Creates a version in packageVersions for ALL types (agent, skill, integration,
 * mcp-server), handles skill upsert + per-type storage upload.
 */
export async function postInstallPackage(params: {
  packageType: PackageType;
  packageId: string;
  orgId: string;
  userId: string;
  content: string;
  files: Record<string, Uint8Array>;
  zipBuffer: Buffer;
  /** Override version instead of auto-detecting from manifest or auto-bumping. */
  version?: string;
}): Promise<void> {
  const { packageType, packageId, orgId, userId, content, files, zipBuffer } = params;

  const manifest = parseManifestFromFiles(files);
  const declaredVersion = manifest.version as string | undefined;

  // Determine version: explicit override > manifest version > error
  const rawVersion = params.version ?? declaredVersion;
  if (!rawVersion || !isValidVersion(rawVersion)) {
    throw new Error(`Package ${packageId}: missing or invalid version in manifest`);
  }
  const version: string = rawVersion;

  if (packageType === "skill") {
    const cfg = CONFIG_BY_TYPE[packageType];
    const item: CreateItemInput = { id: packageId, content, createdBy: userId };
    await upsertItem(orgId, packageId, item, cfg, manifest);
    await uploadPackageFiles(cfg.storageFolder, orgId, packageId, files);
  }

  if (packageType === "agent" && Object.keys(files).length > 0) {
    await uploadPackageFiles("agents", orgId, packageId, files);
  }

  if (packageType === "integration" && Object.keys(files).length > 0) {
    // Vendored MCP server code (`server/`), the manifest, and the
    // optional INTEGRATION.md companion all live alongside each other
    // in the AFPS bundle — store the whole tree under integrations/.
    // Phase 1.2a's resolver consumes the same payload at spawn time.
    await uploadPackageFiles("integrations", orgId, packageId, files);
  }

  if (packageType === "mcp-server" && Object.keys(files).length > 0) {
    // AFPS-native manifest (with MCPB-vocabulary `server` / `tools` /
    // `user_config` lifted to the root alongside AFPS identity — NOT
    // strict-MCPB; see §3.4) plus any vendored server tree. Stored under
    // mcp-servers/ so the spawn resolver can serve the bundle to an
    // integration whose `source.kind: "local"` references it.
    await uploadPackageFiles("mcp-servers", orgId, packageId, files);
  }

  // No try/catch: a genuine version-creation failure MUST propagate so the
  // caller (e.g. bundle import) aborts rather than committing a `packages`
  // row with no version (an un-runnable orphan). `createVersionAndUpload`
  // already cleans up its uploaded ZIP on DB failure before re-throwing.
  await createVersionAndUpload({
    packageId,
    version,
    createdBy: userId,
    zipBuffer,
    manifest,
  });
}
