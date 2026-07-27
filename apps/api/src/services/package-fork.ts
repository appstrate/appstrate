// SPDX-License-Identifier: Apache-2.0

import { parseScopedName, isOwnedByOrg } from "@appstrate/core/naming";
import {
  dropRetiredRuntimeTools,
  validateManifest,
  type PackageType,
} from "@appstrate/core/validation";
import { logger } from "../lib/logger.ts";

import { zipArtifact } from "@appstrate/core/zip";
import { getPackageById, createOrgItem } from "./package-items/crud.ts";
import { uploadPackageFiles } from "./package-items/storage.ts";
import { CONFIG_BY_TYPE, type PackageTypeConfig } from "./package-items/config.ts";

import { getLatestVersionId, createVersionAndUpload } from "./package-versions.ts";
import { downloadVersionZip, unzipAndNormalize } from "./package-storage.ts";
import { db } from "@appstrate/db/client";
import { packageVersions } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { asRecord } from "@appstrate/core/safe-json";

export interface ForkResult {
  packageId: string;
  type: string;
  forked_from: string;
}

export type ForkError =
  | { code: "ALREADY_OWNED" }
  | { code: "NOT_FOUND" }
  | { code: "NAME_COLLISION"; existingId: string }
  | { code: "UNKNOWN_TYPE"; type: string }
  | { code: "NO_PUBLISHED_VERSION" };

export async function forkPackage(
  orgId: string,
  orgSlug: string,
  sourcePackageId: string,
  userId?: string,
  customName?: string,
): Promise<ForkResult | ForkError> {
  if (isOwnedByOrg(sourcePackageId, orgSlug)) {
    return { code: "ALREADY_OWNED" };
  }

  const parsed = parseScopedName(sourcePackageId);
  if (!parsed) return { code: "NOT_FOUND" };

  // Read the package row directly — `packages.type` already holds the type,
  // so there's no need to probe each CONFIG_BY_TYPE candidate.
  const raw = await getPackageById(sourcePackageId);
  if (!raw) return { code: "NOT_FOUND" };

  // Cross-org fork of a PUBLISHED package is an intended feature (the "fork a
  // shared/published package into your org" flow — see the cross-org fork
  // integration tests). The only fork-able source is one with a published
  // version: `forkWithConfig` below requires `getLatestVersionId` and returns
  // NO_PUBLISHED_VERSION otherwise, so an org's UNPUBLISHED/draft working copy
  // (the genuinely private surface the review flagged) is never forkable across
  // orgs. Publishing a version is therefore the fork-visibility signal; we do
  // NOT additionally gate on `orgId` here, which would break the documented
  // cross-org fork feature. (See remediation ledger: forkPackage org-scope
  // finding — false positive for published packages.)
  const cfg = CONFIG_BY_TYPE[raw.type as PackageType];
  if (!cfg) return { code: "UNKNOWN_TYPE", type: raw.type };

  return forkWithConfig(orgId, orgSlug, sourcePackageId, customName ?? parsed.name, cfg, userId);
}

async function forkWithConfig(
  orgId: string,
  orgSlug: string,
  sourcePackageId: string,
  sourceName: string,
  cfg: PackageTypeConfig,
  userId?: string,
): Promise<ForkResult | ForkError> {
  // Resolve latest published version of the source
  const latestVersionId = await getLatestVersionId(sourcePackageId);
  if (!latestVersionId) return { code: "NO_PUBLISHED_VERSION" };

  const [versionRow] = await db
    .select({
      version: packageVersions.version,
      manifest: packageVersions.manifest,
    })
    .from(packageVersions)
    .where(eq(packageVersions.id, latestVersionId))
    .limit(1);

  if (!versionRow) return { code: "NO_PUBLISHED_VERSION" };

  // Download the source version ZIP
  const sourceZip = await downloadVersionZip(sourcePackageId, versionRow.version);
  if (!sourceZip) return { code: "NO_PUBLISHED_VERSION" };

  // Extract content from the ZIP
  const zipEntries = unzipAndNormalize(sourceZip);
  const decoder = new TextDecoder();
  const content = zipEntries["prompt.md"]
    ? decoder.decode(zipEntries["prompt.md"])
    : zipEntries["SKILL.md"]
      ? decoder.decode(zipEntries["SKILL.md"])
      : "";

  // Build target packageId
  const targetId = `@${orgSlug}/${sourceName}`;

  // Check for collision
  const existing = await getPackageById(targetId);
  if (existing) return { code: "NAME_COLLISION", existingId: targetId };

  // Build manifest from the published version snapshot, update name
  const versionManifest = asRecord(versionRow.manifest);

  // Normalise ONCE, here, because a fork is a read that MINTS. It reads a
  // manifest that is already published — immutable by construction, so a
  // `runtime_tools` id the platform retired after that publish can never be
  // repaired at the source — and turns it into a brand new immutable artifact.
  // Rejecting would make every legacy agent permanently un-forkable (the same
  // reason `createVersionFromDraft` drops rather than fails); carrying the id
  // forward verbatim would regrave the retired legacy into a version row + ZIP
  // minted today. `dropRetiredRuntimeTools` is structural (no Zod re-parse):
  // key order, unknown fields and absent defaults survive it untouched, so it
  // never introduces a difference of its own. (The fork's bytes still differ
  // from the source's — the manifest is re-serialised from a jsonb read, which
  // reorders keys, and `zipArtifact` rebuilds the archive.)
  //
  // BEFORE `createOrgItem`, not later: this one object feeds all three sinks —
  // the draft row, the draft storage files, and the published version (row +
  // ZIP). Normalising only the version would leave the retired id in the fork's
  // draft, and the fork's first re-publish would mint it right back.
  const { manifest: updatedManifest, dropped: droppedRuntimeTools } = dropRetiredRuntimeTools({
    ...versionManifest,
    name: targetId,
  });
  if (droppedRuntimeTools.length > 0) {
    logger.info("dropped retired runtime tools from forked manifest", {
      sourcePackageId,
      packageId: targetId,
      version: versionRow.version,
      dropped: droppedRuntimeTools,
    });
  }

  // Look, warn, NEVER reject. The drop above closes the retired-tool hole, but
  // a source manifest invalid for any other reason (missing `type` /
  // `schema_version`, a null/array jsonb column) would otherwise mint a fresh
  // draft row, version row and ZIP unnoticed. Rejecting is not an option:
  // manifests today's validator refuses DO sit in the catalog, and a gate here
  // would make them permanently un-forkable — the fork is a READ of an
  // immutable, unrepairable artifact. Two sources, both real:
  //   - the provider→integration migration (#481, shipped in beta.17) left
  //     `type: "provider"` manifests behind; they were repaired by a one-off
  //     backfill script that no longer exists in this repo;
  //   - `POST /api/mcp-servers` can still MINT one today: a malformed
  //     `manifest.json` makes `parseManifestBytesSafe` return undefined, so
  //     `routes/packages.ts` skips its `if (parsed.manifest)` validation
  //     entirely and `createOrgItem` synthesizes a `{version, name, type}` stub
  //     that `createVersionSafe` then writes into `package_versions.manifest`.
  // So the operator gets a log line, and the fork proceeds.
  const validation = validateManifest(updatedManifest, { retiredRuntimeTools: "drop" });
  if (!validation.valid) {
    logger.warn("forking an invalid published manifest", {
      sourcePackageId,
      packageId: targetId,
      version: versionRow.version,
      errors: validation.errors,
    });
  }

  // Same reason the check above only warns, applied to the identity itself: a
  // drifted `type` (the `provider` rows #481 left behind, or a snapshot whose
  // type no longer matches its `packages.type` row) sits in an immutable,
  // unrepairable artifact, so the fork is the one path allowed to normalize it.
  // `createOrgItem` used to do this silently for every caller, which is how a
  // manifest valid for one type became a stored manifest no schema accepts
  // (issue #987); it now REFUSES divergence, so the repair lives here.
  if (updatedManifest.type !== cfg.type) {
    logger.warn("normalizing drifted manifest type on fork", {
      sourcePackageId,
      packageId: targetId,
      version: versionRow.version,
      manifestType: String(updatedManifest.type),
      packageType: cfg.type,
    });
    updatedManifest.type = cfg.type;
  }

  // Create the fork package (draft)
  const newPkg = await createOrgItem(
    orgId,
    {
      id: targetId,
      name:
        typeof versionManifest.display_name === "string" ? versionManifest.display_name : undefined,
      description:
        typeof versionManifest.description === "string" ? versionManifest.description : undefined,
      content,
      createdBy: userId,
    },
    cfg,
    updatedManifest,
    sourcePackageId,
  );

  // Build draft storage files from the version ZIP entries
  const draftFiles: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(zipEntries)) {
    if (path === "manifest.json") continue;
    draftFiles[path] = data;
  }
  draftFiles["manifest.json"] = new TextEncoder().encode(JSON.stringify(updatedManifest, null, 2));
  await uploadPackageFiles(cfg.storageFolder, orgId, newPkg.id, draftFiles);

  const newZipBuffer = Buffer.from(zipArtifact(draftFiles, 6));

  // Create a local published version
  await createVersionAndUpload({
    packageId: newPkg.id,
    version: versionRow.version,
    createdBy: userId ?? null,
    zipBuffer: newZipBuffer,
    manifest: updatedManifest,
  });

  return {
    packageId: newPkg.id,
    type: cfg.type,
    forked_from: sourcePackageId,
  };
}
