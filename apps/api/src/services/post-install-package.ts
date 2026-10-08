// SPDX-License-Identifier: Apache-2.0

import { parseManifestFromFiles } from "../lib/manifest-parser.ts";
import {
  assertVersionNotLower,
  createVersionAndUpload,
  finalizeDraftPublication,
  getVersionForDownload,
  replaceVersionContent,
} from "./package-versions.ts";
import { computeIntegrity } from "@appstrate/core/integrity";
import { createPackageDraft, mutatePackageDraftFiles } from "./package-files.ts";
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
  /**
   * Home space for a row this call has to CREATE (a skill the bundle brought
   * along) — the importing space, which owns what it imports. An existing
   * package keeps the home it already has: an install never moves a package.
   */
  homeSpaceId: string;
  /** Preserve the caller's creation intent: a concurrent insertion must conflict. */
  create: boolean;
  draftManifest?: Record<string, unknown>;
  lockVersion?: number;
  /** Override version instead of auto-detecting from manifest or auto-bumping. */
  version?: string;
  /** A forced import: an existing version with different bytes is replaced by `zipBuffer`. */
  replaceExistingVersion?: boolean;
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

  // Before the draft is replaced: a refused version must leave it untouched.
  if (!params.create) await assertVersionNotLower(packageId, version);

  const draft = params.create
    ? await createPackageDraft({
        orgId,
        id: packageId,
        type: packageType,
        content,
        createdBy: userId,
        homeSpaceId: params.homeSpaceId,
        manifest: params.draftManifest ?? manifest,
        files,
      })
    : await mutatePackageDraftFiles(
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
  const published = await createVersionAndUpload({
    packageId,
    version,
    createdBy: userId,
    zipBuffer,
    manifest,
  });
  if (!published) {
    // A concurrent publish raised the highest version after the check above.
    await assertVersionNotLower(packageId, version);
    throw new Error(`Package ${packageId}: version ${version} was not created`);
  }
  if (published.outcome === "exists") {
    // A concurrent publish can land after the importer's own check: only the
    // stored row says whether the draft matches this version.
    const stored = await getVersionForDownload(packageId, version);
    if (stored?.integrity !== computeIntegrity(new Uint8Array(zipBuffer))) {
      if (!params.replaceExistingVersion) return;
      await replaceVersionContent({ packageId, version, zipBuffer, manifest });
    }
  }
  // The draft holds what that version holds. A non-latest version is left alone by the callee.
  await finalizeDraftPublication({
    packageId,
    orgId,
    lockVersion: draft.lockVersion,
    versionId: published.id,
  });
}
