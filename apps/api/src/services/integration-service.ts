// SPDX-License-Identifier: Apache-2.0

/**
 * Integration package CRUD service — INTEGRATIONS_PROPOSAL Phase 1.0.
 *
 * Scope (deliberately narrow): read-side queries + a thin install helper.
 * Mutations (publish, install, connect) and runtime side (proxy, MCP
 * Router, OAuth flows) come in Phases 1.05, 1.1, 1.2a.
 *
 * Mirrors `provider-service.ts` for the read path so the package list
 * UI can surface integrations alongside providers without
 * special-casing.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, packages, packageVersions } from "@appstrate/db/schema";
import { asRecord } from "@appstrate/core/safe-json";
import { integrationManifestSchema } from "@appstrate/core/integration";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { logger } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntegrationSummary {
  /** Package id (e.g. `@official/gmail`). */
  id: string;
  /** Latest manifest snapshot — the validated, type-narrowed view. */
  manifest: IntegrationManifest;
  /** Owning org. `null` for system packages. */
  orgId: string | null;
  /** `"local"` for user-published, `"system"` for built-ins. */
  source: "local" | "system";
}

export interface IntegrationVersionRow {
  versionId: number;
  version: string;
  integrity: string;
  manifest: IntegrationManifest;
  yanked: boolean;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Narrow the JSONB manifest column into the typed view. Returns `null`
 * if the row is not actually an integration manifest — defensive
 * against partial DB writes (e.g. a row whose `type` was migrated but
 * whose manifest hasn't caught up).
 */
function asIntegrationManifest(raw: unknown): IntegrationManifest | null {
  const parsed = integrationManifestSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Fetch a single integration by id, restricted to packages visible to
 * the org (own packages + system packages). Returns `null` when absent
 * or when the row has been corrupted enough to fail manifest parsing —
 * the caller should treat both as `404` for UX consistency.
 */
export async function getIntegration(
  orgId: string,
  packageId: string,
): Promise<IntegrationSummary | null> {
  const [row] = await db
    .select({
      id: packages.id,
      orgId: packages.orgId,
      source: packages.source,
      draftManifest: packages.draftManifest,
    })
    .from(packages)
    .where(
      and(
        orgOrSystemFilter(orgId),
        notEphemeralFilter(),
        eq(packages.id, packageId),
        eq(packages.type, "integration"),
      ),
    )
    .limit(1);

  if (!row) return null;
  const manifest = asIntegrationManifest(row.draftManifest);
  if (!manifest) {
    logger.warn("Integration manifest failed validation; treating as missing", {
      packageId,
    });
    return null;
  }
  return {
    id: row.id,
    manifest,
    orgId: row.orgId,
    source: row.source as "local" | "system",
  };
}

/**
 * List every integration accessible to the org. Manifests that fail
 * validation are skipped (with a structured warning) rather than
 * aborting the whole query — one broken row shouldn't hide the rest.
 */
export async function listIntegrations(orgId: string): Promise<IntegrationSummary[]> {
  const rows = await db
    .select({
      id: packages.id,
      orgId: packages.orgId,
      source: packages.source,
      draftManifest: packages.draftManifest,
    })
    .from(packages)
    .where(and(orgOrSystemFilter(orgId), notEphemeralFilter(), eq(packages.type, "integration")));

  const out: IntegrationSummary[] = [];
  for (const row of rows) {
    const manifest = asIntegrationManifest(row.draftManifest);
    if (!manifest) {
      logger.warn("Skipping integration row with invalid manifest", { packageId: row.id });
      continue;
    }
    out.push({
      id: row.id,
      manifest,
      orgId: row.orgId,
      source: row.source as "local" | "system",
    });
  }
  return out;
}

/**
 * Fetch a specific published version's manifest snapshot. Used by the
 * future runtime resolver to materialise an integration at a frozen
 * version (Phase 1.2a). For Phase 1.0, exposed so tests can assert
 * that bundle-import populated `packageVersions` correctly.
 */
export async function getIntegrationVersion(
  orgId: string,
  packageId: string,
  version: string,
): Promise<IntegrationVersionRow | null> {
  const [pkg] = await db
    .select({ id: packages.id })
    .from(packages)
    .where(
      and(orgOrSystemFilter(orgId), eq(packages.id, packageId), eq(packages.type, "integration")),
    )
    .limit(1);
  if (!pkg) return null;

  const [row] = await db
    .select({
      versionId: packageVersions.id,
      version: packageVersions.version,
      integrity: packageVersions.integrity,
      manifest: packageVersions.manifest,
      yanked: packageVersions.yanked,
    })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
    .limit(1);

  if (!row) return null;
  const manifest = asIntegrationManifest(row.manifest);
  if (!manifest) return null;

  return {
    versionId: row.versionId,
    version: row.version,
    integrity: row.integrity,
    manifest,
    yanked: row.yanked,
  };
}

/**
 * Check whether an integration is installed in an application. The
 * runtime resolver (Phase 1.2a) reads this same join to decide which
 * integrations to spawn for an agent run.
 */
export async function isIntegrationInstalled(
  applicationId: string,
  packageId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ packageId: applicationPackages.packageId })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Helpers exposed for tests / future routes
// ---------------------------------------------------------------------------

/**
 * Narrow a raw JSONB manifest into the validated integration manifest.
 * Exposed so route handlers can validate user-supplied manifests
 * without depending on the Zod schema directly.
 */
export function parseIntegrationManifest(
  raw: unknown,
): { valid: true; manifest: IntegrationManifest } | { valid: false; errors: string[] } {
  const parsed = integrationManifestSchema.safeParse(raw);
  if (parsed.success) return { valid: true, manifest: parsed.data };
  return {
    valid: false,
    errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}

/**
 * Lift a `draftManifest` JSONB blob into a stricter typed view. Returns
 * `null` on parse failure (silent, no throw) so callers can render a
 * graceful empty-state instead of a 500.
 */
export function safeManifestFromRow(draftManifest: unknown): IntegrationManifest | null {
  const obj = asRecord(draftManifest);
  if (Object.keys(obj).length === 0) return null;
  return asIntegrationManifest(obj);
}
