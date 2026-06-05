// SPDX-License-Identifier: Apache-2.0

/**
 * Integration package read-side service.
 *
 * Scope (deliberately narrow): read-side queries for the integration package
 * list/detail UI + a thin install helper. Mutations (connect, OAuth flows)
 * and the runtime credential/spawn path live in their own services.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageVersions, packageDistTags } from "@appstrate/db/schema";
import { integrationManifestSchema } from "@appstrate/core/integration";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { mcpServerManifestSchema, type McpServerManifest } from "@appstrate/core/mcp-server";
import { getSystemPackages } from "./system-packages.ts";
import type { IntegrationSummary } from "@appstrate/shared-types";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { pickVersion } from "./run-launcher/db-package-catalog.ts";
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

/**
 * Discriminated failure modes for {@link resolveMcpServerForSpawn} — distinct
 * from "package missing" so the spawn resolver can log WHY an integration was
 * skipped (a leaked diagnosis cycle in prod traced to the silent
 * stale-draft/latest-bytes split; see issue #588).
 */
export type McpServerResolveFailure =
  | "not_found"
  | "not_mcp_server"
  | "invalid_manifest"
  /** A published version exists, but none satisfied `source.server.version`. */
  | "unsatisfiable_pin"
  /** The package exists but has no published version to run. */
  | "no_published_version";

export type McpServerResolution =
  | {
      ok: true;
      manifest: McpServerManifest;
      /**
       * The CONCRETE version the spawn will run. `null` for system
       * mcp-servers (single version served from the boot registry — no
       * `package_versions` row, no `?version=` needed on the byte route).
       */
      version: string | null;
      /** `"system"` → boot registry bytes; `"version"` → published `.afps`. */
      source: "system" | "version";
    }
  | { ok: false; reason: McpServerResolveFailure };

/**
 * Resolve a referenced `mcp-server` package to a CONCRETE version, honoring the
 * `source.server.version` pin, and return that version's manifest.
 *
 * This is the single resolution contract for the local-source spawn path. It
 * replaces the previous split where the manifest was read from
 * `packages.draft_manifest` (version-blind) while the runnable bytes came from
 * the latest non-yanked `package_versions` row (pin-blind, and independent of
 * the manifest version) — so a `publish` that didn't also overwrite the draft
 * left the run executing one version's bytes under another version's manifest
 * (issue #588). Here the manifest comes from `package_versions.manifest` for the
 * SAME `version` the byte route is told to serve, so they can never skew.
 *
 * Resolution order mirrors every other platform catalog: exact → dist-tag →
 * semver range (yanked versions visible only to an exact pin). A missing /
 * empty pin resolves to the `"latest"` dist-tag. System packages short-circuit
 * to the in-memory boot registry (single version, served by id alone).
 *
 * Unscoped (no orgId filter) — callers already hold an auth context (run token
 * / service-internal call), matching {@link fetchMcpServerManifest}.
 */
export async function resolveMcpServerForSpawn(
  packageId: string,
  pin?: string | null,
): Promise<McpServerResolution> {
  // System mcp-servers are loaded once at boot and served from the in-memory
  // registry by id — there is no `package_versions` row to pin against, and the
  // byte route resolves them the same way (issue #588 only concerns
  // separately-versioned local packages).
  const sys = getSystemPackages().get(packageId);
  if (sys) {
    const parsed = mcpServerManifestSchema.safeParse(sys.manifest);
    if (!parsed.success) {
      logger.warn("system mcp-server manifest failed validation", { packageId });
      return { ok: false, reason: "invalid_manifest" };
    }
    return { ok: true, manifest: parsed.data, version: null, source: "system" };
  }

  const [pkgRow] = await db
    .select({ type: packages.type })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkgRow) {
    logger.info("referenced mcp-server package not found", { packageId });
    return { ok: false, reason: "not_found" };
  }
  if (pkgRow.type !== "mcp-server") {
    logger.warn("referenced package is not an mcp-server", {
      packageId,
      actualType: pkgRow.type,
    });
    return { ok: false, reason: "not_mcp_server" };
  }

  const [versionRows, tagRows] = await Promise.all([
    db
      .select({
        version: packageVersions.version,
        integrity: packageVersions.integrity,
        yanked: packageVersions.yanked,
        manifest: packageVersions.manifest,
      })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, packageId))
      .orderBy(desc(packageVersions.createdAt)),
    db
      .select({ tag: packageDistTags.tag, version: packageVersions.version })
      .from(packageDistTags)
      .innerJoin(packageVersions, eq(packageDistTags.versionId, packageVersions.id))
      .where(eq(packageDistTags.packageId, packageId)),
  ]);

  if (versionRows.length === 0) {
    logger.warn("referenced mcp-server has no published version", { packageId, pin });
    return { ok: false, reason: "no_published_version" };
  }

  // Missing/empty pin → "latest" (the working-copy default; the org run path
  // treats `source.server.version` as advisory). `pickVersion` applies the
  // canonical exact → dist-tag → range resolution and the yanked-visibility
  // rule shared with `DbPackageCatalog`.
  const spec = pin && pin.trim().length > 0 ? pin.trim() : "latest";
  const picked = pickVersion(
    spec,
    versionRows.map((v) => ({ version: v.version, integrity: v.integrity, yanked: v.yanked })),
    tagRows,
  );
  if (!picked) {
    logger.warn("source.server.version pin could not be satisfied for mcp-server", {
      packageId,
      pin: spec,
      available: versionRows.map((v) => v.version),
    });
    return { ok: false, reason: "unsatisfiable_pin" };
  }

  const row = versionRows.find((v) => v.version === picked.version);
  const parsed = mcpServerManifestSchema.safeParse(row?.manifest);
  if (!parsed.success) {
    logger.warn("mcp-server version manifest failed validation", {
      packageId,
      version: picked.version,
    });
    return { ok: false, reason: "invalid_manifest" };
  }
  return { ok: true, manifest: parsed.data, version: picked.version, source: "version" };
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
 * Per-integration prompt companion returned by
 * {@link fetchIntegrationPromptDocs}. `description` comes from the
 * integration manifest; `doc` is the raw `INTEGRATION.md` content
 * (AFPS §3.5) parsed at install time and persisted on
 * `packages.draftContent`. Either may be absent.
 */
export interface IntegrationPromptDoc {
  packageId: string;
  description?: string;
  doc?: string;
}

/** Soft cap on `INTEGRATION.md` content inlined in the platform prompt. */
const INTEGRATION_DOC_INLINE_LIMIT_BYTES = 50 * 1024;

/**
 * Decode `bytes` as UTF-8, capped at `limit` bytes. Backs up to the nearest
 * UTF-8 leading-byte boundary so the tail of the truncated output never
 * contains a U+FFFD replacement char from a partial multi-byte sequence.
 */
function truncateUtf8(bytes: Uint8Array, limit: number): string {
  if (bytes.length <= limit) return new TextDecoder().decode(bytes);
  let cut = limit;
  // Back up while the byte at `cut - 1` is a UTF-8 continuation byte (0b10xxxxxx).
  // Max 3 step-backs needed (a 4-byte sequence has at most 3 continuation bytes).
  while (cut > 0 && ((bytes[cut - 1] ?? 0) & 0xc0) === 0x80) {
    cut--;
  }
  // If the byte at `cut - 1` is itself a leading byte of a multi-byte sequence
  // (0b11xxxxxx), its continuation bytes were just cut off — back up one more
  // to exclude the partial start byte.
  if (cut > 0) {
    const lead = bytes[cut - 1] ?? 0;
    if ((lead & 0xc0) === 0xc0) {
      cut--;
    }
  }
  return new TextDecoder().decode(bytes.slice(0, cut));
}

/**
 * Truncate `raw` to the inline byte budget, respecting UTF-8 code-point
 * boundaries so the tail never holds a partial multi-byte sequence. Appends
 * a plain truncation marker with the original/cap byte counts.
 */
function truncateIntegrationDoc(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  if (bytes.byteLength <= INTEGRATION_DOC_INLINE_LIMIT_BYTES) return raw;
  const truncated = truncateUtf8(bytes, INTEGRATION_DOC_INLINE_LIMIT_BYTES);
  return `${truncated}\n\n[…truncated — original ${bytes.length} bytes capped at ${INTEGRATION_DOC_INLINE_LIMIT_BYTES} bytes]`;
}

/**
 * Batch-load `(description, INTEGRATION.md)` for a set of integration
 * package ids. Reads from `packages.draftManifest` (description) +
 * `packages.draftContent` (the `INTEGRATION.md` content captured at
 * install time by `zip.ts`) — never re-fetches the bundle from object
 * storage. Returned entries are sized to the inline-budget; oversized
 * docs are truncated on a UTF-8 code-point boundary with a plain
 * truncation marker.
 *
 * Rows with no `INTEGRATION.md` (the optional companion is absent) yield
 * an entry with `doc` undefined. Rows that fail to load yield no entry.
 */
export async function fetchIntegrationPromptDocs(
  packageIds: readonly string[],
): Promise<IntegrationPromptDoc[]> {
  if (packageIds.length === 0) return [];
  const rows = await db
    .select({
      id: packages.id,
      type: packages.type,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
    })
    .from(packages)
    .where(and(inArray(packages.id, packageIds as string[]), eq(packages.type, "integration")));

  const out: IntegrationPromptDoc[] = [];
  for (const row of rows) {
    const manifest = asIntegrationManifest(row.draftManifest);
    const description = manifest?.description;
    // `draftContent` for integrations is the raw INTEGRATION.md when
    // present, or a fallback to the manifest JSON when the package was
    // uploaded without an INTEGRATION.md (see `packages/core/src/zip.ts`).
    // Only inline content that looks like markdown documentation, not
    // the manifest JSON fallback.
    const rawContent = row.draftContent ?? "";
    const looksLikeJsonFallback =
      rawContent.trimStart().startsWith("{") && rawContent.trimEnd().endsWith("}");
    const doc =
      rawContent.trim().length > 0 && !looksLikeJsonFallback
        ? truncateIntegrationDoc(rawContent)
        : undefined;
    out.push({
      packageId: row.id,
      ...(description ? { description } : {}),
      ...(doc ? { doc } : {}),
    });
  }
  return out;
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
