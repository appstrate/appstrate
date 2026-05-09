// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve a `kind: "registry"` source on `POST /api/runs/remote` to a
 * concrete `LoadedPackage` + version label.
 *
 * The CLI (or any remote runner) tells us which package it's running
 * — `{ packageId, stage: "draft" | "published", spec? }` — instead of
 * shipping the manifest+prompt blob and relying on fingerprint
 * reconciliation. This produces:
 *   - deterministic attribution (no hash-equality games),
 *   - clean draft handling (the `versionLabel` is literally `"draft"`),
 *   - immunity to spoofing (the server reads the manifest from its own
 *     storage; the runner cannot impersonate `@official/agent`).
 *
 * Resolution mirrors the bundle export route (`GET .../bundle`):
 *   - `stage: "draft"`     → `getPackage` reads `draftManifest`/`draftContent`.
 *                            `versionLabel = "draft"`. `spec` is rejected.
 *   - `stage: "published"` → `resolveExportVersion` (explicit `spec` →
 *                            pinned-in-app version → `latest` dist-tag).
 *                            Manifest + prompt loaded from `package_versions`.
 *
 * Access control: the package must exist in the org's catalog AND be
 * installed in the calling application — same 404 semantics the bundle
 * route already enforces.
 */

import { getPackage, resolveManifestCatalogDeps } from "./package-catalog.ts";
import { hasPackageAccess } from "./application-packages.ts";
import { getVersionDetail } from "./package-versions.ts";
import { resolveExportVersion } from "./bundle-assembly.ts";
import { ApiError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import { validateManifest } from "@appstrate/core/validation";
import type { AgentManifest, LoadedPackage } from "../types/index.ts";

export interface RegistrySourceInput {
  orgId: string;
  applicationId: string;
  packageId: string;
  stage: "draft" | "published";
  spec?: string | undefined;
  /**
   * SRI digest the runner received with the bundle download. Optional;
   * surfaces a structured warn-log when it diverges from the artifact
   * the resolved version stores (catches dist-tag drift, mid-flight
   * draft edits). Never a rejection signal — bundle bytes already live
   * on the runner, so wasting that work on a 4xx is no security gain.
   */
  integrityHint?: string;
}

export interface ResolvedRegistryAgent {
  agent: LoadedPackage;
  /** Version label to display on the run row (`"draft"` or a concrete semver). */
  versionLabel: string;
}

export async function resolveRegistryAgent(
  input: RegistrySourceInput,
): Promise<ResolvedRegistryAgent> {
  const { orgId, applicationId, packageId, stage, spec, integrityHint } = input;

  if (stage === "draft" && spec) {
    throw new ApiError({
      status: 400,
      code: "draft_with_spec",
      title: "Conflicting Source",
      detail: "stage: 'draft' cannot be combined with a spec — drafts have no published id",
    });
  }

  const pkg = await getPackage(packageId, orgId);
  if (!pkg) {
    throw new ApiError({
      status: 404,
      code: "package_not_found",
      title: "Package Not Found",
      detail: `Package '${packageId}' not found in this organization`,
    });
  }

  if (!(await hasPackageAccess({ orgId, applicationId }, packageId))) {
    throw new ApiError({
      status: 404,
      code: "package_not_installed_in_app",
      title: "Package Not Installed",
      detail:
        `Package '${packageId}' exists in this organization but is not installed in application '${applicationId}'. ` +
        `Install it via POST /api/applications/${applicationId}/packages, or pick a different application.`,
    });
  }

  if (stage === "draft") {
    // `getPackage` already returned the draft state (`draftManifest`/
    // `draftContent`). Run the full AFPS structural validation —
    // type-dispatched so an agent with a corrupt `dependencies` shape,
    // missing `schemaVersion`, etc. fails cleanly here instead of
    // crashing deeper in the run pipeline with a less actionable error.
    const draftValidation = validateManifest(pkg.manifest);
    if (!draftValidation.valid) {
      throw new ApiError({
        status: 400,
        code: "invalid_draft_manifest",
        title: "Invalid Draft Manifest",
        detail: `Draft for '${pkg.id}' is invalid: ${draftValidation.errors.slice(0, 3).join("; ")}`,
      });
    }

    if (integrityHint) {
      // Drafts mutate freely — any hint the runner saw on download is
      // structurally racy. Log unconditionally (no comparison; we'd need
      // to re-zip to check), so ops can correlate "draft edited mid-run".
      logger.warn("registry run integrity hint on draft (best-effort observability)", {
        packageId: pkg.id,
        versionLabel: "draft",
        integrityHint,
      });
    }

    return { agent: pkg, versionLabel: "draft" };
  }

  // Published path. `resolveExportVersion` handles three resolution
  // shapes: explicit spec, pinned-in-app version, "latest" dist-tag.
  // It throws `notFound` if nothing resolves — let it bubble.
  const version = await resolveExportVersion(packageId, { orgId, applicationId }, spec ?? null);
  const detail = await getVersionDetail(packageId, version);
  if (!detail) {
    throw new ApiError({
      status: 404,
      code: "version_not_found",
      title: "Version Not Found",
      detail: `Version '${version}' of '${packageId}' is not available`,
    });
  }
  if (detail.yanked) {
    throw new ApiError({
      status: 410,
      code: "version_yanked",
      title: "Version Yanked",
      detail: `Version '${version}' of '${packageId}' has been yanked${
        detail.yankedReason ? ` (${detail.yankedReason})` : ""
      }`,
    });
  }

  // Validate the snapshotted manifest from the catalog row. Anything
  // malformed here is a service invariant violation (bad publish, manual
  // SQL edit) — surface as 500 rather than letting an unchecked cast
  // through to the run pipeline.
  const manifestValidation = validateManifest(detail.manifest);
  if (!manifestValidation.valid) {
    logger.error("stored published manifest failed AFPS validation", {
      packageId,
      version: detail.version,
      errors: manifestValidation.errors.slice(0, 5),
    });
    throw new ApiError({
      status: 500,
      code: "invalid_stored_manifest",
      title: "Invalid Stored Manifest",
      detail: `Catalog row for '${packageId}@${detail.version}' has a malformed manifest`,
    });
  }
  if (manifestValidation.manifest.type !== "agent") {
    throw new ApiError({
      status: 400,
      code: "not_an_agent",
      title: "Not An Agent",
      detail: `Package '${packageId}' is a ${manifestValidation.manifest.type}, not an agent`,
    });
  }
  const manifest = manifestValidation.manifest as AgentManifest;

  if (integrityHint && integrityHint !== detail.integrity) {
    // The runner downloaded under one digest; we resolved a row with a
    // different artifact digest. Most likely cause: the dist-tag the
    // runner pointed at (often `latest`) moved between bundle download
    // and `runs/remote` POST. We accept the run regardless (the bundle
    // still lives on the runner, server-side bytes aren't loaded), but
    // emit a structured warn so ops can correlate.
    logger.warn("registry run integrity hint diverges from resolved artifact", {
      packageId,
      versionLabel: detail.version,
      hint: integrityHint,
      resolved: detail.integrity,
    });
  }

  const prompt = detail.textContent ?? "";
  const deps = await resolveManifestCatalogDeps(manifest, orgId);

  // Build the LoadedPackage from the published version's manifest + prompt
  // while preserving the package row's identity (id, source, updatedAt).
  // `pkg` already carries `source` (system/local) and `updatedAt` — those
  // describe the row, not the version, so they pass through unchanged.
  const agent: LoadedPackage = {
    id: pkg.id,
    manifest,
    prompt,
    skills: deps.skills,
    tools: deps.tools,
    source: pkg.source,
    ...(pkg.updatedAt ? { updatedAt: pkg.updatedAt } : {}),
  };

  return { agent, versionLabel: detail.version };
}
