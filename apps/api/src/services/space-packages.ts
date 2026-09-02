// SPDX-License-Identifier: Apache-2.0

/**
 * Space-level package management — install, uninstall, list, and configure
 * packages within a space context.
 */

import { eq, and, or, sql, isNotNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spacePackages, packages, packageVersions, packageDistTags } from "@appstrate/db/schema";
import { notFound, conflict, parseBody } from "../lib/errors.ts";
import { inputSettingsSchema } from "../lib/jsonb-schemas.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { PackageType } from "@appstrate/core/validation";
import type { ResolvedRunConfig } from "@appstrate/shared-types";
import type { SpaceScope } from "../lib/scope.ts";
import { assertSpaceInScope } from "./spaces.ts";
import { ApiError } from "../lib/errors.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { parsePackageZip } from "@appstrate/core/zip";
import { getVersionForDownload } from "./package-versions.ts";
import { downloadVersionZip } from "./package-storage.ts";

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

/**
 * Historical mcp-server drafts may predate companion-file validation. Refuse
 * to install one unless the exact `latest` archive is present and passes the
 * same parser used at authoring/import and runtime boot. System packages are
 * boot-registry artifacts and do not have a package_versions row here.
 */
async function assertMcpServerInstallable(scope: SpaceScope, packageId: string): Promise<void> {
  const [pkg] = await db
    .select({ type: packages.type, source: packages.source })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(scope.orgId), notEphemeralFilter()))
    .limit(1);
  if (!pkg || pkg.type !== "mcp-server" || pkg.source === "system") return;

  const version = await getVersionForDownload(packageId, "latest");
  if (!version) {
    throw new ApiError({
      status: 422,
      code: "bundle_invalid",
      title: "Invalid MCP Server Bundle",
      detail: `MCP-server package '${packageId}' has no installable published version.`,
    });
  }

  try {
    const bytes = await downloadVersionZip(packageId, version.version, version.integrity);
    if (!bytes) throw new Error(`archive for ${packageId}@${version.version} is missing`);
    const parsed = parsePackageZip(new Uint8Array(bytes), { retiredRuntimeTools: "drop" });
    if (parsed.type !== "mcp-server" || parsed.packageId !== packageId) {
      throw new Error(
        `archive identity is ${parsed.packageId} (${parsed.type}), expected ${packageId} (mcp-server)`,
      );
    }
  } catch (err) {
    throw new ApiError({
      status: 422,
      code: "bundle_invalid",
      title: "Invalid MCP Server Bundle",
      detail: `MCP-server package '${packageId}@${version.version}' is not executable: ${getErrorMessage(err)}`,
    });
  }
}

/**
 * Install a package into a space.
 *
 * Deliberately takes no initial values: `space_packages.input_settings`
 * holds the agent's editor-set input defaults, and it has exactly ONE write
 * path — `PUT /api/agents/{scope}/{name}/input-settings`, which validates them
 * against `manifest.input.schema` and refuses a locked required field with no
 * value behind it. An install writes the column's empty default and nothing
 * else.
 */
export async function installPackage(scope: SpaceScope, packageId: string) {
  await assertSpaceInScope(scope);
  await assertMcpServerInstallable(scope, packageId);

  // The org-visibility check and the insert run in ONE transaction so the
  // tenant boundary is atomic with the write — a separate preflight would
  // leave a window where a `space_packages` row could be grafted onto
  // a package the org cannot see.
  return db.transaction(async (tx) => {
    // Verify the package exists in the org catalog (or is a system package).
    // Ephemeral shadow packages are never installable.
    const [pkg] = await tx
      .select({ id: packages.id, type: packages.type })
      .from(packages)
      .where(and(eq(packages.id, packageId), orgOrSystemFilter(scope.orgId), notEphemeralFilter()))
      .limit(1);

    if (!pkg) {
      throw notFound(`Package '${packageId}' not found in organization catalog`);
    }

    // Check not already installed
    const [existing] = await tx
      .select({ packageId: spacePackages.packageId })
      .from(spacePackages)
      .where(and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.packageId, packageId)))
      .limit(1);

    if (existing) {
      throw conflict(
        "already_installed",
        `Package '${packageId}' is already installed in this space`,
      );
    }

    const [row] = await tx
      .insert(spacePackages)
      .values({
        spaceId: scope.spaceId,
        packageId,
      })
      .returning();

    return row!;
  });
}

export async function uninstallPackage(scope: SpaceScope, packageId: string): Promise<void> {
  const deleted = await db
    .delete(spacePackages)
    .where(and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.packageId, packageId)))
    .returning({ packageId: spacePackages.packageId });

  if (deleted.length === 0) {
    throw notFound(`Package '${packageId}' is not installed in this space`);
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

// Stored input values (`space_packages.input_settings`) are deliberately
// NOT projected here: this listing is the install / enable / pin surface, and
// the agent's stored values are read through `GET /api/agents/{scope}/{name}`
// where they travel with the schema and the locks that give them meaning
// (`AgentDetail.input`).
const installedPackageSelect = {
  packageId: spacePackages.packageId,
  generationConfig: spacePackages.generationConfig,
  modelId: spacePackages.modelId,
  proxyId: spacePackages.proxyId,
  version_id: spacePackages.versionId,
  enabled: spacePackages.enabled,
  installed_at: spacePackages.installedAt,
  updatedAt: spacePackages.updatedAt,
  package_type: packages.type,
  package_source: packages.source,
  draft_manifest: packages.draftManifest,
};

export async function listInstalledPackages(scope: SpaceScope, type?: PackageType) {
  // `orgOrSystemFilter` for the same reason as `getInstalledPackage` below: a
  // stray association row pointing at another org's package (writable before
  // the atomic install/update checks existed) must not surface that package's
  // draft_manifest in the listing.
  const conditions = [eq(spacePackages.spaceId, scope.spaceId), orgOrSystemFilter(scope.orgId)];
  if (type) {
    conditions.push(eq(packages.type, type));
  }

  return db
    .select(installedPackageSelect)
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .where(and(...conditions));
}

export async function getInstalledPackage(scope: SpaceScope, packageId: string) {
  // `orgOrSystemFilter` lands in the SQL WHERE so this can never act as a
  // cross-tenant existence/type oracle: a stray association row pointing at
  // another org's package id resolves to `null`, exactly like a package that
  // does not exist.
  const [row] = await db
    .select(installedPackageSelect)
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .where(
      and(
        eq(spacePackages.spaceId, scope.spaceId),
        eq(spacePackages.packageId, packageId),
        orgOrSystemFilter(scope.orgId),
      ),
    )
    .limit(1);

  return row ?? null;
}

// ---------------------------------------------------------------------------
// Accessible packages — system packages + explicitly installed (single query)
// ---------------------------------------------------------------------------

/**
 * WHERE for "visible in this space, of this `type`": system packages (always
 * visible) + packages explicitly installed in `space_packages`, org-or-system
 * owned, never an ephemeral shadow. Expects `spacePackages` LEFT JOINed on
 * (package, this space). Shared by `listAccessiblePackages` and the bounded
 * hint query so the two can never disagree on what is accessible.
 */
function accessiblePackagesFilter(scope: SpaceScope, type: PackageType) {
  return and(
    eq(packages.type, type),
    orgOrSystemFilter(scope.orgId),
    notEphemeralFilter(),
    // system packages always visible, local packages only if installed
    or(eq(packages.source, "system"), isNotNull(spacePackages.packageId)),
  );
}

/**
 * ORDER BY for accessible-package listings: system first, then by id. The
 * tie-break is load-bearing rather than cosmetic: Postgres does not order rows
 * within an equal sort key, so two identical calls could hand back different
 * permutations. The chat renders this list (capped, via
 * `listInstalledPackageHints`) into its system prompt, which pi-ai emits as ONE
 * cache block with ONE breakpoint — a reshuffle rewrites the prompt and
 * invalidates the cached prefix, and the conversation history behind it. It
 * also makes the CAP itself stable: without a total order, which 15 of N
 * packages survive the limit is undefined.
 */
function accessiblePackagesOrder() {
  return [sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`, packages.id];
}

/**
 * List all packages accessible to a space, filtered by type.
 * Accessible = system packages (always visible) + explicitly installed in space_packages.
 * Single query via LEFT JOIN — no N+1.
 */
export async function listAccessiblePackages(scope: SpaceScope, type: PackageType) {
  return db
    .select({
      id: packages.id,
      type: packages.type,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      source: packages.source,
      // space_packages columns (null for system packages). The agent's
      // stored input values are NOT projected here — `getInstalledPackageSettings`
      // is the reader for those, and it travels with the locks.
      spaceModelId: spacePackages.modelId,
      spaceProxyId: spacePackages.proxyId,
      spaceVersionId: spacePackages.versionId,
      spaceEnabled: spacePackages.enabled,
      // `latest` dist-tag version id — non-null iff the package has a published
      // version. Lets callers tell published agents from draft-only ones without
      // an N+1 (a draft-only agent must be run with `version=draft`).
      latestVersionId: packageDistTags.versionId,
    })
    .from(packages)
    .leftJoin(
      spacePackages,
      and(eq(spacePackages.packageId, packages.id), eq(spacePackages.spaceId, scope.spaceId)),
    )
    .leftJoin(
      packageDistTags,
      and(eq(packageDistTags.packageId, packages.id), eq(packageDistTags.tag, "latest")),
    )
    .where(accessiblePackagesFilter(scope, type))
    .orderBy(...accessiblePackagesOrder());
}

// ---------------------------------------------------------------------------
// Installed-package hints — caller-context for the chat / get_me payload
// ---------------------------------------------------------------------------

/**
 * Fields shared by every installed-package hint (agents, skills, …). Per-type
 * extras (an agent's `takes_input`, a skill's `version`) are layered on top by
 * the projection passed to `listInstalledPackageHints`.
 */
interface PackageHint {
  /** Package identifier, e.g. "@appstrate/triage" / "@appstrate/web-research". */
  package_id: string;
  display_name: string;
  description: string;
  source: string;
  /**
   * True when the package has a published version (a `latest` dist-tag) or is a
   * system package. A draft-only package is `false` — callers must run it with
   * `version=draft` (omitting `version` would 404 `no_published_version`).
   */
  published: boolean;
}

const DEFAULT_PACKAGE_HINT_LIMIT = 15;

/**
 * List the packages of one `type` an actor in this space could use, as a
 * bounded hint for the get_me / chat-prompt caller context. "Installed" =
 * visible in the space (`accessiblePackagesFilter`) AND not disabled per-space.
 * System packages are always enabled. The list is capped (`limit`) so a large
 * catalog doesn't bloat the system prompt — the long tail stays reachable via
 * `search_operations`.
 *
 * Bounded IN SQL. This runs twice per chat turn (agents, then skills) on the
 * TTFT path: the enabled filter and the LIMIT sit in the query, so only the
 * returned rows' manifests (`draft_manifest` JSONB) cross the wire, and
 * `total` rides along as a window count over the filtered set (evaluated
 * before the LIMIT, so it is the size of the whole catalog, not of the page).
 * The ordering is `accessiblePackagesOrder` — the same total order as
 * `listAccessiblePackages`, which is what makes the cap deterministic.
 *
 * The base hint (id/name/description/source) is uniform across package types;
 * `project` layers on the type-specific extras from the manifest. Access gating
 * is NOT enforced here — the caller decides whether to surface the hint, and the
 * run / inline-run route re-validates at invoke time.
 */
async function listInstalledPackageHints<T extends PackageHint>(
  scope: SpaceScope,
  type: PackageType,
  project: (base: PackageHint, manifest: Record<string, unknown>) => T,
  opts?: { limit?: number },
): Promise<{ items: T[]; truncated: boolean; total: number }> {
  const limit = opts?.limit ?? DEFAULT_PACKAGE_HINT_LIMIT;
  const rows = await db
    .select({
      id: packages.id,
      source: packages.source,
      draftManifest: packages.draftManifest,
      // `latest` dist-tag version id — non-null iff the package has a
      // published version (see `listAccessiblePackages`).
      latestVersionId: packageDistTags.versionId,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(packages)
    .leftJoin(
      spacePackages,
      and(eq(spacePackages.packageId, packages.id), eq(spacePackages.spaceId, scope.spaceId)),
    )
    .leftJoin(
      packageDistTags,
      and(eq(packageDistTags.packageId, packages.id), eq(packageDistTags.tag, "latest")),
    )
    .where(
      and(
        accessiblePackagesFilter(scope, type),
        // `enabled` is null for system packages (no space_packages row) — null
        // counts as enabled; only an explicit `false` disables a local install.
        sql`${spacePackages.enabled} IS DISTINCT FROM false`,
      ),
    )
    .orderBy(...accessiblePackagesOrder())
    .limit(limit);

  const total = rows[0]?.total ?? 0;

  const items = rows.map((row) => {
    const manifest = asRecord(row.draftManifest) as Record<string, unknown>;
    const base: PackageHint = {
      package_id: typeof manifest.name === "string" ? manifest.name : row.id,
      display_name: typeof manifest.display_name === "string" ? manifest.display_name : "",
      description: typeof manifest.description === "string" ? manifest.description : "",
      source: row.source ?? "local",
      published: row.source === "system" || row.latestVersionId != null,
    };
    return project(base, manifest);
  });

  return { items, truncated: total > items.length, total };
}

/** One entry in the runnable-agent hint exposed via get_me / the chat prompt. */
interface RunnableAgent extends PackageHint {
  /** Whether the agent declares an input schema with at least one property. */
  takes_input: boolean;
}

interface RunnableAgentsResult {
  agents: RunnableAgent[];
  /** True when the catalog was capped by `limit` (more reachable via search). */
  truncated: boolean;
  /** Total runnable agents before the cap. */
  total: number;
}

/**
 * Runnable-agent hint for the caller context. "Runnable" is a hint only — the
 * caller gates on the `agents:run` permission and the run route re-checks RBAC
 * at invoke time. See {@link listInstalledPackageHints}.
 */
export async function listRunnableAgents(
  scope: SpaceScope,
  opts?: { limit?: number },
): Promise<RunnableAgentsResult> {
  const { items, truncated, total } = await listInstalledPackageHints(
    scope,
    "agent",
    (base, manifest) => {
      const properties = asRecord(asRecord(asRecord(manifest.input).schema).properties);
      return { ...base, takes_input: Object.keys(properties).length > 0 };
    },
    opts,
  );
  return { agents: items, truncated, total };
}

/** One entry in the installed-skill hint exposed via get_me / the chat prompt. */
interface InstalledSkill extends PackageHint {
  /** The skill package's own manifest version, when known — pin a satisfiable
   * `dependencies.skills` range from it. */
  version: string | null;
}

interface InstalledSkillsResult {
  skills: InstalledSkill[];
  /** True when the catalog was capped by `limit` (more reachable via search). */
  truncated: boolean;
  /** Total installed skills before the cap. */
  total: number;
}

/**
 * Installed-skill hint for the caller context. Skills are not run directly: the
 * model declares them under an agent manifest's `dependencies.skills`, and the
 * inline-run preflight validates they exist at invoke time. Same `agents:run`
 * caller gate as agents. See {@link listInstalledPackageHints}.
 */
export async function listInstalledSkills(
  scope: SpaceScope,
  opts?: { limit?: number },
): Promise<InstalledSkillsResult> {
  const { items, truncated, total } = await listInstalledPackageHints(
    scope,
    "skill",
    (base, manifest) => ({
      ...base,
      version: typeof manifest.version === "string" ? manifest.version : null,
    }),
    opts,
  );
  return { skills: items, truncated, total };
}

/**
 * Check if a space has access to a specific package.
 * System packages are always accessible; local packages require installation.
 */
export async function hasPackageAccess(scope: SpaceScope, packageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: packages.id })
    .from(packages)
    .leftJoin(
      spacePackages,
      and(eq(spacePackages.packageId, packages.id), eq(spacePackages.spaceId, scope.spaceId)),
    )
    .where(
      and(
        eq(packages.id, packageId),
        notEphemeralFilter(),
        or(eq(packages.source, "system"), isNotNull(spacePackages.packageId)),
      ),
    )
    .limit(1);

  return !!row;
}

// ---------------------------------------------------------------------------
// Installed-package settings (per-space) — single source of truth for everything
// the `space_packages` row carries about one package: the agent's stored
// input values, their locks, and the model/proxy overrides.
// ---------------------------------------------------------------------------

/** Per-space settings for one package — the whole row, projected. */
export interface InstalledPackageSettings {
  /**
   * Editor-set default values for the agent's input fields — layer 2 of the
   * input resolution (`services/input-resolution.ts`).
   */
  values: Record<string, unknown>;
  /** Input fields no caller may set at launch. */
  locked: string[];
  modelId: string | null;
  generationConfig: import("@appstrate/core/model-generation").ModelGenerationSettings | null;
  proxyId: string | null;
}

export async function getInstalledPackageSettings(
  spaceId: string,
  packageId: string,
): Promise<InstalledPackageSettings> {
  const [row] = await db
    .select({
      inputSettings: spacePackages.inputSettings,
      generationConfig: spacePackages.generationConfig,
      modelId: spacePackages.modelId,
      proxyId: spacePackages.proxyId,
    })
    .from(spacePackages)
    .where(and(eq(spacePackages.spaceId, spaceId), eq(spacePackages.packageId, packageId)))
    .limit(1);
  // JSONB read: narrow both members rather than trusting the column's
  // declared `$type`.
  const stored = row?.inputSettings;
  return {
    values: asRecord(stored?.values),
    locked: Array.isArray(stored?.locked) ? stored.locked : [],
    modelId: row?.modelId ?? null,
    generationConfig: row?.generationConfig ?? null,
    proxyId: row?.proxyId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Resolved run-config — single source of truth for both the UI's per-space
// agent run and the CLI's `appstrate run @scope/agent` invocation. The
// CLI reads this endpoint after profile resolution to reproduce the UI
// run byte-for-byte (same model, proxy, generation settings, version pin)
// unless the user passed an explicit override flag.
//
// Wire shape lives in `@appstrate/shared-types` so the CLI consumes the
// same interface without redeclaring it.
// ---------------------------------------------------------------------------

/**
 * Resolve the per-space run configuration for `(spaceId,
 * packageId)`. Returns `null` when no `space_packages` row exists
 * for the pair — the caller (route or CLI) decides whether that is a
 * 404 or a "no inheritance, fall back to flags + defaults" signal.
 *
 * The org filter lands in the SQL WHERE (`orgOrSystemFilter`) so a stray
 * association row pointing at another org's package id resolves to `null`
 * instead of leaking its model/proxy/version pin.
 *
 * `input` republishes the row's stored input values and locks — layer 2 of
 * `services/input-resolution.ts`. The CLI needs them because `appstrate run
 * @scope/agent --local` executes the bundle on the caller's machine, where no
 * server-side resolution runs.
 */
export async function getResolvedRunConfig(
  scope: SpaceScope,
  packageId: string,
): Promise<ResolvedRunConfig | null> {
  const [row] = await db
    .select({
      inputSettings: spacePackages.inputSettings,
      generationConfig: spacePackages.generationConfig,
      modelId: spacePackages.modelId,
      proxyId: spacePackages.proxyId,
      versionId: spacePackages.versionId,
      draftManifest: packages.draftManifest,
    })
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .where(
      and(
        eq(spacePackages.spaceId, scope.spaceId),
        eq(spacePackages.packageId, packageId),
        orgOrSystemFilter(scope.orgId),
      ),
    )
    .limit(1);

  if (!row) return null;

  let versionPin: string | null = null;
  if (row.versionId !== null && row.versionId !== undefined) {
    // Constrain the pin lookup to THIS package's versions — a client-supplied
    // `versionId` pointing at another package's version row must not resolve
    // (and must never reveal a foreign package's version string).
    const [versionRow] = await db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(and(eq(packageVersions.id, row.versionId), eq(packageVersions.packageId, packageId)))
      .limit(1);
    versionPin = versionRow?.version ?? null;
  }

  // JSONB read: narrow both members rather than trusting the column's
  // declared `$type` (same narrowing as `getInstalledPackageSettings`).
  const stored = row.inputSettings;

  return {
    generation: row.generationConfig ?? null,
    modelId: row.modelId ?? null,
    proxyId: row.proxyId ?? null,
    version_pin: versionPin,
    input: {
      values: asRecord(stored?.values),
      locked_fields: Array.isArray(stored?.locked) ? stored.locked : [],
    },
  };
}

/**
 * Update the per-space settings row for `(spaceId, packageId)`.
 *
 * The org-visibility check runs in the SAME transaction as the write — never
 * as a separate preflight — so the write can never graft an
 * `space_packages` row onto a package id the org cannot see (another
 * org's package, or an ephemeral shadow row).
 *
 * Two modes:
 *   - `requireInstalled: true` (the public
 *     `PUT /spaces/:id/packages/:packageId` route): the association row
 *     MUST already exist — an update that would create a new row is a client
 *     error (404), never an implicit install.
 *   - default (agent input-settings/proxy/model routes, integration activate /
 *     deactivate): upsert. A SYSTEM package legitimately has no
 *     `space_packages` row until its first per-space setting is written,
 *     so create-on-first-write is intended there. Those routes preflight the
 *     package via `requireAgent()` / `assertIsIntegration()`; the in-transaction
 *     check below re-enforces the same boundary atomically.
 */
export async function updateInstalledPackage(
  scope: SpaceScope,
  packageId: string,
  updates: {
    inputSettings?: { values: Record<string, unknown>; locked: string[] };
    modelId?: string | null;
    generationConfig?: import("@appstrate/core/model-generation").ModelGenerationSettings | null;
    proxyId?: string | null;
    versionId?: number | null;
    enabled?: boolean;
  },
  opts?: { requireInstalled?: boolean },
): Promise<void> {
  const set: Partial<{
    updatedAt: Date;
    inputSettings: { values: Record<string, unknown>; locked: string[] };
    modelId: string | null;
    generationConfig: import("@appstrate/core/model-generation").ModelGenerationSettings | null;
    proxyId: string | null;
    versionId: number | null;
    enabled: boolean;
  }> = { updatedAt: new Date() };
  // `space_packages.input_settings` has exactly ONE write path, and it is
  // this function — the public input-settings route and every internal caller
  // both land here. The column's byte cap therefore belongs on THIS side of the
  // call rather than in the route body schema, which an internal caller would
  // simply walk past. `parseBody` renders a cap violation as the same RFC-9457
  // 400 the route would have produced (`errors[0].field === "input_settings"`).
  const inputSettings =
    updates.inputSettings === undefined
      ? undefined
      : parseBody(inputSettingsSchema, updates.inputSettings, "input_settings");
  if (inputSettings !== undefined) set.inputSettings = inputSettings;
  if (updates.modelId !== undefined) set.modelId = updates.modelId;
  if (updates.generationConfig !== undefined) set.generationConfig = updates.generationConfig;
  if (updates.proxyId !== undefined) set.proxyId = updates.proxyId;
  if (updates.versionId !== undefined) set.versionId = updates.versionId;
  if (updates.enabled !== undefined) set.enabled = updates.enabled;

  await db.transaction(async (tx) => {
    // Tenant boundary, atomic with the write: the target package must be
    // visible to the org (own or system) and not an ephemeral shadow row.
    const [pkg] = await tx
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.id, packageId), orgOrSystemFilter(scope.orgId), notEphemeralFilter()))
      .limit(1);
    if (!pkg) {
      throw notFound(`Package '${packageId}' not found in organization catalog`);
    }

    if (opts?.requireInstalled) {
      const updated = await tx
        .update(spacePackages)
        .set(set)
        .where(
          and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.packageId, packageId)),
        )
        .returning({ packageId: spacePackages.packageId });
      if (updated.length === 0) {
        throw notFound(`Package '${packageId}' is not installed in this space`);
      }
      return;
    }

    await tx
      .insert(spacePackages)
      .values({
        spaceId: scope.spaceId,
        packageId,
        ...(inputSettings !== undefined ? { inputSettings } : {}),
        ...(updates.modelId !== undefined ? { modelId: updates.modelId } : {}),
        ...(updates.generationConfig !== undefined
          ? { generationConfig: updates.generationConfig }
          : {}),
        ...(updates.proxyId !== undefined ? { proxyId: updates.proxyId } : {}),
        ...(updates.versionId !== undefined ? { versionId: updates.versionId } : {}),
        ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [spacePackages.spaceId, spacePackages.packageId],
        set,
      });
  });
}
