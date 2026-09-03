// SPDX-License-Identifier: Apache-2.0

import { parseScopedName, isOwnedByOrg } from "@appstrate/core/naming";
import {
  dropRetiredRuntimeTools,
  validateManifest,
  type PackageType,
} from "@appstrate/core/validation";
import { logger } from "../lib/logger.ts";

import { zipArtifact } from "@appstrate/core/zip";
import { checkSkillMarkdown, decodeSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { PACKAGE_CONTENT_ENTRY } from "@appstrate/core/package-files";
import { getPackageById, createOrgItem } from "./package-items/crud.ts";
import { uploadPackageFiles } from "./package-items/storage.ts";
import { CONFIG_BY_TYPE, type PackageTypeConfig } from "./package-items/config.ts";

import { getLatestVersionId, createVersionAndUpload } from "./package-versions.ts";
import { downloadVersionZip } from "./package-storage.ts";
import { unzipPackageArchive } from "./package-archive.ts";
import { db } from "@appstrate/db/client";
import { packageVersions } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { asRecord } from "@appstrate/core/safe-json";

interface ForkResult {
  packageId: string;
  type: string;
  forked_from: string;
  /**
   * Non-blocking notices about what the fork could NOT do. Present only when
   * the draft was created but its published version was skipped — the caller
   * must be told what to fix, or the fork looks complete and the missing
   * version surfaces much later as "no published version".
   */
  warnings?: string[];
}

type ForkError =
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

  const zipEntries = unzipPackageArchive(sourceZip);

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
  // immutable, unrepairable artifact. One source remains, and it is legacy
  // only: the provider→integration migration (#481, shipped in beta.17) left
  // `type: "provider"` manifests behind, repaired at the time by a one-off
  // backfill script no longer in this repo. #987 closed the write direction —
  // every create path now validates author input unconditionally and 400s — so
  // no NEW invalid manifest enters the catalog; this fork is the one path that
  // still propagates the legacy ones, which is the price of staying forkable.
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

  // `packages.draft_content` of the fork, read from the SAME declaration every
  // other writer of that column reads (`PACKAGE_CONTENT_ENTRY`) rather than
  // from a hardcoded `prompt.md`/`SKILL.md` pair. That pair covered two of the
  // four types: an integration forked to `""` even when its bundle shipped a
  // real `INTEGRATION.md`, and an mcp-server always did — a column NO import of
  // the same bytes would ever produce, which then read back as a 0-byte
  // `INTEGRATION.md` in the file explorer and as "ships no doc" to
  // `fetchIntegrationPromptDocs`, while `?version=…` still served the file.
  //
  // The absence branch reproduces `parsePackageZip`'s own manifest-text
  // fallback, so the fork's column is byte-identical to what importing the
  // fork's bytes would have stored — INCLUDING the rewrite: the manifest text
  // is the fork's OWN manifest (renamed, normalized), the exact bytes written
  // to `manifest.json` in both draft storage and the published ZIP below.
  //
  // A REQUIRED entry missing from the archive gets no fallback, because the
  // parser has none either (`checkCompanionFiles` rejects such a bundle at
  // import). Storing the manifest there would make `applyDraftOverlay`
  // materialize manifest JSON AS the agent's `prompt.md`.
  const manifestText = JSON.stringify(updatedManifest, null, 2);
  const contentEntry = PACKAGE_CONTENT_ENTRY[cfg.type];
  const contentBytes = contentEntry ? zipEntries[contentEntry.path] : undefined;
  // BOM-preserving decode: this string is both what the §3.3 gate below judges
  // and what lands in `draft_content`, and the archive entry copied alongside
  // it keeps its bytes either way — a default `TextDecoder` would make the
  // column disagree with the file and hide a BOM from the gate.
  const content = contentBytes
    ? decodeSkillMarkdown(contentBytes)
    : contentEntry?.required
      ? ""
      : manifestText;

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
  // The SAME `manifestText` the content fallback above may have been stored
  // from, so "the column equals this package's manifest.json" is structural
  // rather than two serializations that happen to agree today.
  draftFiles["manifest.json"] = new TextEncoder().encode(manifestText);
  await uploadPackageFiles(cfg.storageFolder, orgId, newPkg.id, draftFiles);

  const newZipBuffer = Buffer.from(zipArtifact(draftFiles, 6));

  // MINT ONLY WHAT WOULD SURVIVE A PUBLISH — the rule `createVersionSafe`
  // (`routes/packages.ts`) already applies on the create path, for the same
  // reason: a version is immutable, so freezing content the publish gate
  // refuses creates an artifact nobody can ever repair.
  //
  // The DRAFT is still created. Forking is precisely how a user takes over a
  // legacy skill they do not own in order to fix it; refusing the fork would
  // leave them with no way to do that. So the fork succeeds, the version is
  // skipped, and the warning says what to fix.
  const warnings: string[] = [];
  const skillViolation = cfg.type === "skill" ? checkSkillMarkdown(content) : null;
  if (skillViolation) {
    logger.info("fork: skipping published version, SKILL.md does not conform to AFPS §3.3", {
      packageId: newPkg.id,
      reason: skillViolation.reason,
    });
    warnings.push(
      `No version was published for ${newPkg.id}: ${skillViolation.message}. ` +
        `Fix SKILL.md in the draft, then publish.`,
    );
  } else {
    // Create a local published version
    await createVersionAndUpload({
      packageId: newPkg.id,
      version: versionRow.version,
      createdBy: userId ?? null,
      zipBuffer: newZipBuffer,
      manifest: updatedManifest,
    });
  }

  return {
    packageId: newPkg.id,
    type: cfg.type,
    forked_from: sourcePackageId,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
