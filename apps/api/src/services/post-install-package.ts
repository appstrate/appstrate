// SPDX-License-Identifier: Apache-2.0

import { parseManifestFromFiles } from "../lib/manifest-parser.ts";
import { createVersionAndUpload } from "./package-versions.ts";
import { createOrgItem, getOrgItem } from "./package-items/crud.ts";
import { mutatePackageDraftFiles } from "./package-files.ts";
import { CONFIG_BY_TYPE } from "./package-items/config.ts";
import { isValidVersion } from "@appstrate/core/semver";
import type { PackageType } from "@appstrate/core/validation";

/**
 * Replace an imported draft through the common writer, then retain the original
 * archive and its manifest as an immutable version for every package type.
 */
export async function postInstallPackage(params: {
  packageType: PackageType;
  packageId: string;
  orgId: string;
  userId: string;
  content: string;
  files: Record<string, Uint8Array>;
  zipBuffer: Buffer;
  draftManifest?: Record<string, unknown>;
  lockVersion?: number;
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

  const cfg = CONFIG_BY_TYPE[packageType];
  if (!(await getOrgItem(orgId, packageId, cfg))) {
    await createOrgItem(
      orgId,
      { id: packageId, content, createdBy: userId },
      cfg,
      params.draftManifest ?? manifest,
    );
  }
  await mutatePackageDraftFiles(
    { id: packageId, type: packageType, orgId },
    {
      precondition: {
        imported: true,
        ...(params.lockVersion !== undefined ? { lockVersion: params.lockVersion } : {}),
      },
      manifest: params.draftManifest ?? manifest,
      draftContent: content,
      replace: files,
    },
  );

  // No try/catch: a genuine version-creation failure MUST propagate so the
  // caller (e.g. bundle import) aborts rather than committing a `packages`
  // row with no version (an un-runnable orphan). `createVersionAndUpload`
  // already cleans up its uploaded ZIP on DB failure before re-throwing.
  //
  // Persist `manifest` — the object parsed out of `files` — NEVER a
  // validator-normalised copy of it. Unlike `createVersionFromDraft`, this path
  // does not build the artifact: the `zipBuffer` is caller-supplied, its integrity IS
  // the version's identity (a bundle reassembled by `reconstructPackageZip`, or
  // the ZIP the user uploaded), so a normalised manifest cannot be reflected in
  // the bytes. Writing the Zod output into the DB column alone would make the
  // row diverge from the ZIP — and pinned runs read the manifest FROM the ZIP,
  // so the divergence would be silent.
  //
  // PRECONDITION: `zipBuffer` and `files` declare the same `manifest.json`.
  // Callers that synthesize a manifest (the skill-only-ZIP fallback on the
  // `/import` routes) must rebuild the archive before calling, not pass the
  // original upload — otherwise the row is fine while the stored archive is
  // unreadable to `extractRootFromAfps`, and every bundle export and pinned run
  // touching the package fails.
  await createVersionAndUpload({
    packageId,
    version,
    createdBy: userId,
    zipBuffer,
    manifest,
  });
}
