// SPDX-License-Identifier: Apache-2.0

/**
 * Integration package read-side service.
 *
 * Scope (deliberately narrow): read-side queries for the integration package
 * list/detail UI + a thin install helper. Mutations (connect, OAuth flows)
 * and the runtime credential/spawn path live in their own services.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import { integrationManifestSchema } from "@appstrate/core/integration";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { mcpServerManifestSchema, type McpServerManifest } from "@appstrate/core/mcp-server";
import type { IntegrationSummary } from "@appstrate/shared-types";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { logger } from "../lib/logger.ts";

export type { IntegrationSummary };

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

/**
 * Discriminated failure modes for {@link fetchIntegrationManifest}.
 * Each caller maps these to its own error shape (throw / null / push to
 * a validation error list) — keeps the helper decoupled from the
 * caller's HTTP semantics.
 */
export type IntegrationManifestLoadFailure =
  | { kind: "not_found" }
  | { kind: "not_integration"; actualType: string }
  | { kind: "invalid_manifest" };

export type IntegrationManifestLoadResult =
  | { ok: true; manifest: IntegrationManifest }
  | { ok: false; failure: IntegrationManifestLoadFailure };

/**
 * Fetch + validate an integration manifest from `packages.draft_manifest`,
 * unscoped (no orgId filter — internal callers already have an authentication
 * context: a run token, a service-internal call, …). Returns a discriminated
 * union so each caller can map the failure mode to its preferred response.
 *
 * Org-scoped reads (marketplace listing/detail) keep their own SELECT in
 * `getIntegration` / `listIntegrations` because they pull additional columns
 * (`orgId`, `source`) under an org+system filter — a single shared helper
 * would force a redundant second roundtrip or leak its SELECT shape.
 */
export async function fetchIntegrationManifest(
  packageId: string,
): Promise<IntegrationManifestLoadResult> {
  const [pkgRow] = await db
    .select({ manifest: packages.draftManifest, type: packages.type })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkgRow) return { ok: false, failure: { kind: "not_found" } };
  if (pkgRow.type !== "integration") {
    return { ok: false, failure: { kind: "not_integration", actualType: pkgRow.type } };
  }
  const parsed = integrationManifestSchema.safeParse(pkgRow.manifest);
  if (!parsed.success) return { ok: false, failure: { kind: "invalid_manifest" } };
  return { ok: true, manifest: parsed.data };
}

/**
 * Resolve an `mcp-server` package's MCPB manifest from the package store.
 *
 * An integration whose `source.kind: "local"` references a SEPARATE
 * `mcp-server` package via `source.server.name`. The spawn resolver looks that
 * package up here (unscoped — internal callers already hold an auth context)
 * and reads its runnable server config (`server.{type, entry_point}`) to build
 * the sidecar spawn spec. Returns `null` when the package is absent, is not an
 * mcp-server, or fails MCPB manifest validation.
 */
export async function fetchMcpServerManifest(packageId: string): Promise<McpServerManifest | null> {
  const [pkgRow] = await db
    .select({ manifest: packages.draftManifest, type: packages.type })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkgRow) {
    logger.info("referenced mcp-server package not found", { packageId });
    return null;
  }
  if (pkgRow.type !== "mcp-server") {
    logger.warn("referenced package is not an mcp-server", {
      packageId,
      actualType: pkgRow.type,
    });
    return null;
  }
  const parsed = mcpServerManifestSchema.safeParse(pkgRow.manifest);
  if (!parsed.success) {
    logger.warn("mcp-server manifest failed validation", { packageId });
    return null;
  }
  return parsed.data;
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
