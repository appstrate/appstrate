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
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { getSystemPackages } from "./system-packages.ts";
import type { IntegrationSummary } from "@appstrate/shared-types";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { pickVersion } from "./run-launcher/db-package-catalog.ts";
import { VERSION_SELECTOR_DRAFT } from "./agent-version-resolver.ts";
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
 * Per-call-graph memo for {@link fetchIntegrationManifest}. The run kickoff
 * path loads the SAME integration manifests several times (readiness check →
 * connection-resolution snapshot → spawn resolver); threading one Map through
 * those call sites dedupes the SELECT + Zod parse within a single run trigger.
 *
 * Deliberately NOT a global/TTL cache — the memo's lifetime is one call graph
 * (one run trigger), so a manifest edit is always visible to the next request
 * (no staleness window). Values are promises so concurrent callers within the
 * same graph share one in-flight query instead of racing duplicates.
 */
export type IntegrationManifestCache = Map<string, Promise<IntegrationManifestLoadResult>>;

/**
 * Fetch + validate an integration manifest from `packages.draft_manifest`,
 * unscoped (no orgId filter — internal callers already have an authentication
 * context: a run token, a service-internal call, …). Returns a discriminated
 * union so each caller can map the failure mode to its preferred response.
 *
 * `cache` (optional) memoizes results per packageId for the caller's call
 * graph — see {@link IntegrationManifestCache}. Omitting it preserves the
 * uncached behaviour exactly.
 *
 * Org-scoped reads (marketplace listing/detail) keep their own SELECT in
 * `getIntegration` / `listIntegrations` because they pull additional columns
 * (`orgId`, `source`) under an org+system filter — a single shared helper
 * would force a redundant second roundtrip or leak its SELECT shape.
 */
export async function fetchIntegrationManifest(
  packageId: string,
  cache?: IntegrationManifestCache,
): Promise<IntegrationManifestLoadResult> {
  if (!cache) return fetchIntegrationManifestUncached(packageId);
  const hit = cache.get(packageId);
  if (hit) return hit;
  const promise = fetchIntegrationManifestUncached(packageId);
  cache.set(packageId, promise);
  return promise;
}

async function fetchIntegrationManifestUncached(
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
// Spawn-time package version resolution (single kernel)
// ---------------------------------------------------------------------------

/**
 * Discriminated failure modes shared by every spawn-time package resolution.
 * Distinct from "package missing" so callers can log WHY a package was skipped
 * (a leaked diagnosis cycle in prod traced to the silent stale-draft/latest-bytes
 * split; see issue #588).
 */
export type PublishedManifestFailure =
  | "not_found"
  | "wrong_type"
  | "invalid_manifest"
  /** A published version exists, but none satisfied the pin. */
  | "unsatisfiable_pin"
  /** The package exists but has no published version to run. */
  | "no_published_version";

type PublishedManifestResolution =
  | { ok: true; rawManifest: unknown; version: string | null; source: "system" | "version" }
  | { ok: false; reason: PublishedManifestFailure };

/**
 * Resolve a package to a CONCRETE published version honoring its pin, and
 * return that version's RAW manifest (unparsed — the caller validates with the
 * schema for its package type). This is the single version-resolution kernel
 * behind both the mcp-server spawn path (#588) and the integration spawn path
 * (#686): the manifest comes from `package_versions.manifest` for the SAME
 * `version` the byte route is told to serve, so manifest and bytes can never
 * skew.
 *
 * Resolution order mirrors every other platform catalog: exact → dist-tag →
 * semver range (yanked versions visible only to an exact pin). A missing /
 * empty pin resolves to the `"latest"` dist-tag. System packages short-circuit
 * to the in-memory boot registry (single version, served by id alone).
 *
 * Org-scoped: `orgId` is required and `orgOrSystemFilter` lands in the SQL
 * WHERE of both the package lookup and the version lookup. Package ids are
 * globally unique, so this is defense in depth against a cross-tenant
 * REFERENCE — a run resolving a package id its org neither owns nor gets from
 * the system registry must fail `not_found`, never feed the spawn path —
 * rather than a collision fix (ids cannot collide across orgs).
 */
async function resolvePublishedManifest(
  packageId: string,
  expectedType: "integration" | "mcp-server",
  orgId: string,
  pin?: string | null,
): Promise<PublishedManifestResolution> {
  // System packages are loaded once at boot and served from the in-memory
  // registry by id — there is no `package_versions` row to pin against, and the
  // byte route resolves them the same way (issue #588 only concerns
  // separately-versioned local packages).
  const sys = getSystemPackages().get(packageId);
  if (sys) {
    return { ok: true, rawManifest: sys.manifest, version: null, source: "system" };
  }

  const [pkgRow] = await db
    .select({ type: packages.type })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId)))
    .limit(1);
  if (!pkgRow) return { ok: false, reason: "not_found" };
  if (pkgRow.type !== expectedType) return { ok: false, reason: "wrong_type" };

  const [versionRows, tagRows] = await Promise.all([
    db
      .select({
        version: packageVersions.version,
        integrity: packageVersions.integrity,
        yanked: packageVersions.yanked,
        manifest: packageVersions.manifest,
      })
      .from(packageVersions)
      // Same tenant boundary on the version lookup itself (not just the
      // package row above) so the two reads can never skew across a
      // concurrent delete/recreate of the package id.
      .innerJoin(
        packages,
        and(eq(packages.id, packageVersions.packageId), orgOrSystemFilter(orgId)),
      )
      .where(eq(packageVersions.packageId, packageId))
      .orderBy(desc(packageVersions.createdAt)),
    db
      .select({ tag: packageDistTags.tag, version: packageVersions.version })
      .from(packageDistTags)
      .innerJoin(packageVersions, eq(packageDistTags.versionId, packageVersions.id))
      .where(eq(packageDistTags.packageId, packageId)),
  ]);

  if (versionRows.length === 0) return { ok: false, reason: "no_published_version" };

  // Missing/empty pin → "latest". `pickVersion` applies the canonical
  // exact → dist-tag → range resolution and the yanked-visibility rule shared
  // with `DbPackageCatalog`.
  const spec = pin && pin.trim().length > 0 ? pin.trim() : "latest";
  const picked = pickVersion(
    spec,
    versionRows.map((v) => ({ version: v.version, integrity: v.integrity, yanked: v.yanked })),
    tagRows,
  );
  if (!picked) return { ok: false, reason: "unsatisfiable_pin" };

  const row = versionRows.find((v) => v.version === picked.version);
  return { ok: true, rawManifest: row?.manifest, version: picked.version, source: "version" };
}

/**
 * Discriminated failure modes for {@link resolveMcpServerForSpawn}. Mirrors
 * {@link PublishedManifestFailure} with the mcp-server-specific `not_mcp_server`
 * name preserved for existing call-site logging.
 */
export type McpServerResolveFailure =
  | "not_found"
  | "not_mcp_server"
  | "invalid_manifest"
  | "unsatisfiable_pin"
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
 * `source.server.version` pin, and return that version's manifest. Thin wrapper
 * over {@link resolvePublishedManifest} + MCPB schema validation.
 *
 * `orgId` is the run's org — required so the spawn can only ever resolve a
 * package the org owns or a system package (defense in depth against a
 * cross-tenant reference).
 */
export async function resolveMcpServerForSpawn(
  packageId: string,
  orgId: string,
  pin?: string | null,
): Promise<McpServerResolution> {
  const res = await resolvePublishedManifest(packageId, "mcp-server", orgId, pin);
  if (!res.ok) {
    const reason: McpServerResolveFailure =
      res.reason === "wrong_type" ? "not_mcp_server" : res.reason;
    logger.warn("mcp-server could not be resolved for spawn", { packageId, pin, reason });
    return { ok: false, reason };
  }
  const parsed = mcpServerManifestSchema.safeParse(res.rawManifest);
  if (!parsed.success) {
    logger.warn("mcp-server manifest failed validation", { packageId, version: res.version });
    return { ok: false, reason: "invalid_manifest" };
  }
  return { ok: true, manifest: parsed.data, version: res.version, source: res.source };
}

// ---------------------------------------------------------------------------
// Integration manifest version resolution (#686)
// ---------------------------------------------------------------------------

/**
 * Which concrete source an integration manifest is read from for a run. Frozen
 * at kickoff (per declared integration) and reused by every later reader so the
 * spawn spec and the long-lived runtime credential path can never skew.
 *
 *   - `draft`   → the mutable working copy (`packages.draft_manifest`) — opted
 *                 into per-run via `dependency_overrides[id] === "draft"`.
 *   - `system`  → the in-memory boot registry (system integrations).
 *   - `version` → a published `package_versions` row (the pinned version).
 */
export type SpawnVersionDescriptor =
  { kind: "draft" } | { kind: "system" } | { kind: "version"; version: string };

/** Frozen resolution recorded on `runs.resolved_integration_versions`. */
export interface ResolvedIntegrationVersion {
  version: string | null;
  source: "version" | "draft" | "system";
}
export type ResolvedIntegrationVersionMap = Record<string, ResolvedIntegrationVersion>;

function descriptorToResolved(d: SpawnVersionDescriptor): ResolvedIntegrationVersion {
  return d.kind === "version"
    ? { version: d.version, source: "version" }
    : { version: null, source: d.kind };
}

/** Map a frozen snapshot entry back into the descriptor the readers consume. */
export function resolvedIntegrationVersionToDescriptor(
  entry: ResolvedIntegrationVersion,
): SpawnVersionDescriptor {
  switch (entry.source) {
    case "draft":
      return { kind: "draft" };
    case "system":
      return { kind: "system" };
    case "version":
      // A `version` source always froze a concrete version; fall back to the
      // latest published only if the snapshot is somehow malformed.
      return entry.version ? { kind: "version", version: entry.version } : { kind: "draft" };
  }
}

/**
 * Read an integration manifest AT a specific resolved version. The single
 * manifest reader for a pinned integration — used both when seeding the
 * kickoff cache and on the runtime credential path (which reads the frozen
 * descriptor off the run row).
 */
export async function readIntegrationManifestAt(
  packageId: string,
  descriptor: SpawnVersionDescriptor,
): Promise<IntegrationManifestLoadResult> {
  if (descriptor.kind === "draft") return fetchIntegrationManifestUncached(packageId);

  if (descriptor.kind === "system") {
    const sys = getSystemPackages().get(packageId);
    if (!sys) return { ok: false, failure: { kind: "not_found" } };
    const parsed = integrationManifestSchema.safeParse(sys.manifest);
    if (!parsed.success) return { ok: false, failure: { kind: "invalid_manifest" } };
    return { ok: true, manifest: parsed.data };
  }

  const [row] = await db
    .select({ manifest: packageVersions.manifest })
    .from(packageVersions)
    .where(
      and(
        eq(packageVersions.packageId, packageId),
        eq(packageVersions.version, descriptor.version),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, failure: { kind: "not_found" } };
  const parsed = integrationManifestSchema.safeParse(row.manifest);
  if (!parsed.success) return { ok: false, failure: { kind: "invalid_manifest" } };
  return { ok: true, manifest: parsed.data };
}

/**
 * Read an integration manifest for a RUN, honoring the version frozen on
 * `runs.resolved_integration_versions` (#686). The single decision point for
 * "frozen version vs draft" — used by every run-scoped reader (credentials
 * resolver, byte-route authz) so the "no frozen entry → draft" fallback lives
 * in ONE place instead of a ternary duplicated per call site.
 *
 *   - `frozen` present → read AT that descriptor (the spawn used the same).
 *   - `frozen` absent (legacy run / soft-resolved integration) → draft, via the
 *     shared per-call-graph `cache` when provided.
 */
export function readIntegrationManifestForRun(
  packageId: string,
  frozen: ResolvedIntegrationVersion | null | undefined,
  cache?: IntegrationManifestCache,
): Promise<IntegrationManifestLoadResult> {
  return frozen
    ? readIntegrationManifestAt(packageId, resolvedIntegrationVersionToDescriptor(frozen))
    : fetchIntegrationManifest(packageId, cache);
}

export type RunIntegrationVersionsResult =
  | { ok: true; versions: ResolvedIntegrationVersionMap }
  | { ok: false; unresolved: Array<{ name: string; versionSpec: string }> };

/**
 * Resolve EVERY declared integration to a concrete manifest version for a run,
 * honoring each `dependencies.integrations.<id>` pin (and any per-run
 * `dependency_overrides`) against PUBLISHED versions — the integration-axis
 * sibling of `RunPackageCatalog` (#666) and the connection cascade snapshot
 * (#199). This is the single point the pin is enforced:
 *
 *   - Seeds the shared `manifestCache` with the resolved manifest keyed by
 *     packageId, so every kickoff reader threading that cache (connection
 *     cascade, spawn resolver, pin checks) honors the pin with NO per-caller
 *     change.
 *   - Returns the frozen `{ version, source }` map to persist on
 *     `runs.resolved_integration_versions`, which the runtime credential path
 *     reads back so a mid-run MITM refresh resolves the SAME version.
 *
 * An unsatisfiable pin (incl. a never-published dependency) is reported as
 * `unresolved` so the caller fails loud with a structured `dependency_unresolved`
 * (422) rather than silently spawning the draft. Soft failures (package
 * missing / wrong type / invalid manifest) are left unseeded — the spawn
 * resolver already drops such integrations with a warning, and the runtime
 * reader falls back to the draft, matching pre-#686 behavior.
 */
export async function resolveRunIntegrationVersions(params: {
  agentManifest: Record<string, unknown>;
  /**
   * The run's org — required tenant boundary for published-version
   * resolution (defense in depth against a cross-tenant reference): a run
   * can only ever resolve a package its org owns or a system package.
   */
  orgId: string;
  dependencyOverrides?: Record<string, string> | null;
  manifestCache?: IntegrationManifestCache;
}): Promise<RunIntegrationVersionsResult> {
  const entries = parseManifestIntegrations(params.agentManifest);
  const versions: ResolvedIntegrationVersionMap = {};
  const unresolved: Array<{ name: string; versionSpec: string }> = [];

  for (const entry of entries) {
    const override = params.dependencyOverrides?.[entry.id];
    let descriptor: SpawnVersionDescriptor;

    if (override === VERSION_SELECTOR_DRAFT) {
      descriptor = { kind: "draft" };
    } else {
      // A non-draft override replaces the manifest pin; otherwise the pin wins.
      const spec = override ?? entry.version;
      const res = await resolvePublishedManifest(entry.id, "integration", params.orgId, spec);
      if (res.ok) {
        descriptor =
          res.source === "system" ? { kind: "system" } : { kind: "version", version: res.version! };
      } else if (res.reason === "unsatisfiable_pin" || res.reason === "no_published_version") {
        // A real pin that cannot be met — fail loud, never fall back to draft.
        unresolved.push({ name: entry.id, versionSpec: spec || "*" });
        continue;
      } else {
        // not_found / wrong_type / invalid — soft. Leave the cache unseeded so
        // the spawn resolver's own miss-handling skips the integration and the
        // runtime reader falls back to draft (pre-#686 behavior).
        logger.info("integration version left unresolved; falling back to draft", {
          integrationId: entry.id,
          reason: res.reason,
        });
        continue;
      }
    }

    // Seed the shared per-run manifest cache so every kickoff reader gets the
    // pinned manifest transparently (one entry per integration, overwriting any
    // draft entry an earlier readiness pass may have memoized).
    if (params.manifestCache) {
      params.manifestCache.set(entry.id, readIntegrationManifestAt(entry.id, descriptor));
    }
    versions[entry.id] = descriptorToResolved(descriptor);
  }

  if (unresolved.length > 0) return { ok: false, unresolved };
  return { ok: true, versions };
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
