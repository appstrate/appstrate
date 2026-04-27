// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve a `kind: "registry"` source on `POST /api/runs/remote` to a
 * concrete `LoadedPackage` + version label.
 *
 * The CLI (or any remote runner) tells us which package it's running
 * — `{ packageId, source: "draft" | "published", spec? }` — instead of
 * shipping the manifest+prompt blob and relying on fingerprint
 * reconciliation. This produces:
 *   - deterministic attribution (no hash-equality games),
 *   - clean draft handling (the `versionLabel` is literally `"draft"`),
 *   - immunity to spoofing (the server reads the manifest from its own
 *     storage; the runner cannot impersonate `@official/agent`).
 *
 * Resolution mirrors the bundle export route (`GET .../bundle`):
 *   - `source: "draft"`   → `getPackage` reads `draftManifest`/`draftContent`.
 *                           `versionLabel = "draft"`. `spec` is rejected.
 *   - `source: "published"` → `resolveExportVersion` (explicit `spec` →
 *                           pinned-in-app version → `latest` dist-tag).
 *                           Manifest + prompt loaded from `package_versions`.
 *
 * Access control: the package must exist in the org's catalog AND be
 * installed in the calling application — same 404 semantics the bundle
 * route already enforces.
 */

import { getPackage, resolveManifestCatalogDeps } from "./agent-service.ts";
import { hasPackageAccess } from "./application-packages.ts";
import { getVersionDetail } from "./package-versions.ts";
import { resolveExportVersion } from "./bundle-assembly.ts";
import { ApiError } from "../lib/errors.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { AgentManifest, LoadedPackage } from "../types/index.ts";

export interface RegistrySourceInput {
  orgId: string;
  applicationId: string;
  packageId: string;
  source: "draft" | "published";
  spec?: string | undefined;
}

export interface ResolvedRegistryAgent {
  agent: LoadedPackage;
  /** Version label to display on the run row (`"draft"` or a concrete semver). */
  versionLabel: string;
}

export async function resolveRegistryAgent(
  input: RegistrySourceInput,
): Promise<ResolvedRegistryAgent> {
  const { orgId, applicationId, packageId, source, spec } = input;

  if (source === "draft" && spec) {
    throw new ApiError({
      status: 400,
      code: "draft_with_spec",
      title: "Conflicting Source",
      detail: "source: 'draft' cannot be combined with a spec — drafts have no published id",
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

  if (source === "draft") {
    // `getPackage` already returned the draft state (`draftManifest`/
    // `draftContent`). Validate the manifest carries the AFPS identity
    // contract before handing it to the run pipeline — same shape check
    // the bundle export performs.
    const draftManifest = pkg.manifest as Record<string, unknown>;
    const name = typeof draftManifest.name === "string" ? draftManifest.name : null;
    const version = typeof draftManifest.version === "string" ? draftManifest.version : null;
    if (!name || !version || !name.startsWith("@") || !name.includes("/")) {
      throw new ApiError({
        status: 400,
        code: "invalid_draft_manifest",
        title: "Invalid Draft Manifest",
        detail: `Draft for '${pkg.id}' is missing a valid scoped name + version — fix the manifest before running`,
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

  const manifest = asRecord(detail.manifest) as AgentManifest;
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
