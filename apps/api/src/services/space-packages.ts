// SPDX-License-Identifier: Apache-2.0

/**
 * Space-level package management — install, uninstall, list, and configure
 * packages within a space context.
 */

import { eq, and, or, sql, isNotNull, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spacePackages, packages, packageShares, packageDistTags } from "@appstrate/db/schema";
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
import { placementReadFilter } from "./package-items/crud.ts";
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
 * Type of a package the org can see, or null when it cannot see it.
 *
 * The space-install routes need it BEFORE the write, because the permission
 * that gates the write is per package type (`agents:configure` vs
 * `skills:write` vs …) and only the row knows the type. Same visibility
 * predicate as `installPackage` below, so a package the org cannot see reads
 * as absent here exactly as it does there — never as a type oracle.
 */
export async function getCatalogPackageType(
  orgId: string,
  packageId: string,
): Promise<PackageType | null> {
  const [row] = await db
    .select({ type: packages.type })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId), notEphemeralFilter()))
    .limit(1);
  return row ? (row.type as PackageType) : null;
}

/** Transaction-local reads the install rule needs. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Is the package OFFERED to this space (`package_shares`)?
 *
 * `FOR UPDATE`, and that is the whole point of reading it here rather than in a
 * route. `revokePackageShare` deletes the offer and the installation it backs
 * in one transaction; an install that read the offer WITHOUT the lock could
 * commit its `space_packages` row after that DELETE had already scanned the
 * table, leaving an installation nothing authorizes. The lock serializes the
 * two: whichever starts second waits, and then sees the other's result — an
 * install that got there first blocks the revoke until its row exists to be
 * deleted, and a revoke that got there first leaves this read finding nothing
 * (READ COMMITTED re-evaluates after the lock releases) so the install refuses.
 */
async function sharedWith(tx: Tx, packageId: string, spaceId: string): Promise<boolean> {
  const [row] = await tx
    .select({ packageId: packageShares.packageId })
    .from(packageShares)
    .where(and(eq(packageShares.packageId, packageId), eq(packageShares.spaceId, spaceId)))
    .limit(1)
    .for("update");
  return !!row;
}

/**
 * Install a package into a space — the ONE door, for a personal space and a
 * team space alike (RBAC spec §6.10, plan decisions 1 and 2).
 *
 * The precondition is the PLACEMENT rule itself: the package must be HOMED here
 * or SHARED here, read under the row lock of the transaction that acts on it
 * (see {@link sharedWith}). An install is deliberately NOT a placement of its
 * own — that would be the one way into a space that never consults
 * `<type>:share`, letting a builder of B pull in A's package while A decided
 * nothing. The placement exists first, or is CREATED by this call, which is
 * what `shareBy` is for.
 *
 * `shareBy` is the caller's id and says "I hold `share` in this package's home,
 * so put the offer in with the installation". The route checks that authority
 * (`assertPackageShareAccess`) before handing it over; here it only means the
 * share row is written in the SAME transaction as the `space_packages` row, so
 * an installation can never exist without the placement that authorizes it.
 *
 * A missing placement without `shareBy` is a 404, never a 403: the package id
 * may be private, and a named refusal would confirm it exists.
 *
 * Deliberately takes no initial values: `space_packages.input_settings` holds
 * the agent's editor-set input defaults, and it has exactly ONE write path —
 * `PUT /api/agents/{scope}/{name}/input-settings`, which validates them against
 * `manifest.input.schema` and refuses a locked required field with no value
 * behind it. An install writes the column's empty default and nothing else.
 *
 * It writes NO version either. Outside its home a package runs the `latest`
 * published version, always; the draft belongs to whoever can write it.
 *
 * Returns the association row plus `shared`: whether THIS call created the
 * offer. The route writes its `package.shared` audit off that flag and not off
 * its own earlier read — the offer may already have existed, or a concurrent
 * install may have written it first (the insert is `onConflictDoNothing`), and
 * an audit entry claiming an act that did not happen is worse than none.
 */
export async function installPackage(
  scope: SpaceScope,
  packageId: string,
  opts?: { shareBy?: string },
) {
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
      .select({
        id: packages.id,
        type: packages.type,
        source: packages.source,
        homeSpaceId: packages.homeSpaceId,
      })
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

    // A SYSTEM package is readable in every space of every organization and
    // takes no share — the placement rule has nothing to say about it, here as
    // in `placementGrantsRead`.
    let shared = false;
    if (pkg.source !== "system" && pkg.homeSpaceId !== scope.spaceId) {
      if (!(await sharedWith(tx, packageId, scope.spaceId))) {
        if (opts?.shareBy === undefined) {
          throw notFound(`Package '${packageId}' not found in organization catalog`);
        }
        const offer = await tx
          .insert(packageShares)
          .values({ packageId, spaceId: scope.spaceId, sharedBy: opts.shareBy })
          .onConflictDoNothing()
          .returning({ packageId: packageShares.packageId });
        shared = offer.length > 0;
      }
    }

    const [row] = await tx
      .insert(spacePackages)
      .values({ spaceId: scope.spaceId, packageId })
      .returning();

    return { ...row!, shared };
  });
}

export async function uninstallPackage(scope: SpaceScope, packageId: string): Promise<void> {
  // The org predicate is the same one `getInstalledPackage` applies, and it
  // belongs on the DELETE for the same reason: `space_packages` carries no
  // `org_id`, so `(space_id, package_id)` alone would remove an association
  // pointing at a package this org cannot see. A stray row of that shape reads
  // as absent everywhere else; it must not be deletable here.
  const deleted = await db
    .delete(spacePackages)
    .where(
      and(
        eq(spacePackages.spaceId, scope.spaceId),
        eq(spacePackages.packageId, packageId),
        inArray(
          spacePackages.packageId,
          db.select({ id: packages.id }).from(packages).where(orgOrSystemFilter(scope.orgId)),
        ),
      ),
    )
    .returning({ packageId: spacePackages.packageId });

  if (deleted.length === 0) {
    throw notFound(`Package '${packageId}' is not installed in this space`);
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

// Stored input values (`space_packages.input_settings`) are deliberately
// NOT projected here: this listing is the install / enable surface, and
// the agent's stored values are read through `GET /api/agents/{scope}/{name}`
// where they travel with the schema and the locks that give them meaning
// (`AgentDetail.input`).
const installedPackageSelect = {
  packageId: spacePackages.packageId,
  generationConfig: spacePackages.generationConfig,
  modelId: spacePackages.modelId,
  proxyId: spacePackages.proxyId,
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
// Readable / installed packages in a space (single query each)
// ---------------------------------------------------------------------------

/**
 * WHERE for "readable from this space, of this `type`" — the placement rule
 * ({@link placementReadFilter}), org-or-system owned, never an ephemeral
 * shadow. Expects `packageShares` LEFT JOINed on (package, this space).
 */
function readablePackagesFilter(scope: SpaceScope, type: PackageType) {
  return and(
    eq(packages.type, type),
    orgOrSystemFilter(scope.orgId),
    notEphemeralFilter(),
    placementReadFilter(scope.spaceId),
  );
}

/**
 * WHERE for "RUNNABLE from this space, of this `type`": system packages
 * (reachable everywhere) + packages explicitly installed in `space_packages`,
 * org-or-system owned, never an ephemeral shadow. Expects `spacePackages` LEFT
 * JOINed on (package, this space).
 *
 * Deliberately NOT the placement rule above. Reading and running are two
 * questions (RBAC spec §6.9): an agent homed here and installed nowhere is
 * listed here and still refused a run, because it would run with THIS space's
 * credentials and nobody activated it. This is the SQL twin of
 * `hasPackageAccess`, and it feeds the caller-context hints — what the model is
 * told it can invoke.
 */
function installedPackagesFilter(scope: SpaceScope, type: PackageType) {
  return and(
    eq(packages.type, type),
    orgOrSystemFilter(scope.orgId),
    notEphemeralFilter(),
    // system packages always reachable, local packages only if installed
    or(eq(packages.source, "system"), isNotNull(spacePackages.packageId)),
  );
}

/**
 * ORDER BY for both listings above: system first, then by id. The
 * tie-break is load-bearing rather than cosmetic: Postgres does not order rows
 * within an equal sort key, so two identical calls could hand back different
 * permutations. The chat renders this list (capped, via
 * `listInstalledPackageHints`) into its system prompt, which pi-ai emits as ONE
 * cache block with ONE breakpoint — a reshuffle rewrites the prompt and
 * invalidates the cached prefix, and the conversation history behind it. It
 * also makes the CAP itself stable: without a total order, which 15 of N
 * packages survive the limit is undefined.
 */
function packageListingOrder() {
  return [sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`, packages.id];
}

/**
 * List every package of one `type` READABLE from a space — the placement rule
 * (`placementReadFilter`), so the index page of a type shows what the detail
 * page, the file explorer and the library already open: homed here, offered
 * here, or system.
 *
 * Single query via LEFT JOIN — no N+1. The `space_packages` join answers a
 * different question and is projected, not filtered on: `installed` says
 * whether this space may RUN the package, which a placement does not grant.
 */
export async function listReadablePackages(scope: SpaceScope, type: PackageType) {
  return db
    .select({
      id: packages.id,
      type: packages.type,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      source: packages.source,
      // Whether the package is activated HERE — an installed `space_packages`
      // row, or a system package, which every space runs. The run routes gate
      // on exactly this (`hasPackageAccess`), so a client that renders a launch
      // control per row can say why it is dead instead of round-tripping to a
      // 404. Not the same question as the WHERE above: this listing is what a
      // space READS.
      installed: sql<boolean>`(${packages.source} = 'system' OR ${spacePackages.packageId} IS NOT NULL)`,
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
      packageShares,
      and(eq(packageShares.packageId, packages.id), eq(packageShares.spaceId, scope.spaceId)),
    )
    .leftJoin(
      packageDistTags,
      and(eq(packageDistTags.packageId, packages.id), eq(packageDistTags.tag, "latest")),
    )
    .where(readablePackagesFilter(scope, type))
    .orderBy(...packageListingOrder());
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
   * system package. `false` means draft-only: omitting the version selector at
   * launch answers `404 no_published_version`.
   */
  published: boolean;
  /**
   * Whether THIS caller may write the package, i.e. whether the draft is theirs
   * to run (`version=draft`, `403 draft_not_writable` otherwise).
   *
   * It travels WITH `published` because the pair is one fact for a consumer:
   * `published: false, home_writable: false` is a package nobody but its author
   * can execute, and a caller context that says "draft only — run with
   * version=draft" to such a reader sends it into a 403 loop.
   */
  home_writable: boolean;
}

const DEFAULT_PACKAGE_HINT_LIMIT = 15;

/**
 * Options every hint listing takes. `homeWritable` is a callback rather than a
 * context because the rule that answers it (`homeWireForCaller`) needs the Hono
 * request — the caller's role in the package's home space, its view-as persona,
 * its credential ceiling — which this service layer deliberately does not take.
 * It is pure and in-memory, so the row above already carries everything it
 * reads and the listing stays one query.
 */
interface HintOptions {
  limit?: number;
  homeWritable?: (pkg: {
    type: PackageType;
    source: string;
    homeSpaceId: string | null;
  }) => boolean;
}

/**
 * List the packages of one `type` an actor in this space could use, as a
 * bounded hint for the get_me / chat-prompt caller context. "Installed" =
 * runnable from the space (`installedPackagesFilter`) AND not disabled per-space.
 * System packages are always enabled. The list is capped (`limit`) so a large
 * catalog doesn't bloat the system prompt — the long tail stays reachable via
 * `search_operations`.
 *
 * Bounded IN SQL. This runs twice per chat turn (agents, then skills) on the
 * TTFT path: the enabled filter and the LIMIT sit in the query, so only the
 * returned rows' manifests (`draft_manifest` JSONB) cross the wire, and
 * `total` rides along as a window count over the filtered set (evaluated
 * before the LIMIT, so it is the size of the whole catalog, not of the page).
 * The ordering is `packageListingOrder` — a total order, which is what
 * makes the cap deterministic.
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
  opts?: HintOptions,
): Promise<{ items: T[]; truncated: boolean; total: number }> {
  const limit = opts?.limit ?? DEFAULT_PACKAGE_HINT_LIMIT;
  const rows = await db
    .select({
      id: packages.id,
      type: packages.type,
      source: packages.source,
      homeSpaceId: packages.homeSpaceId,
      draftManifest: packages.draftManifest,
      // `latest` dist-tag version id — non-null iff the package has a
      // published version (see `listReadablePackages`).
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
        installedPackagesFilter(scope, type),
        // `enabled` is null for system packages (no space_packages row) — null
        // counts as enabled; only an explicit `false` disables a local install.
        sql`${spacePackages.enabled} IS DISTINCT FROM false`,
      ),
    )
    .orderBy(...packageListingOrder())
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
      // Decided by the CALLER's authority over the package's home, which this
      // service has no context to read — the route resolves it and hands the
      // verdict down. Absent resolver (no HTTP caller) ⇒ nobody authors here.
      home_writable: opts?.homeWritable?.(row) ?? false,
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
  opts?: HintOptions,
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
  opts?: HintOptions,
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
// run byte-for-byte (same model, proxy, generation settings) unless the user
// passed an explicit override flag. It carries no VERSION: which bytes run is
// the launch selector's business, not the installation's.
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
 * instead of leaking its model/proxy override.
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

  // JSONB read: narrow both members rather than trusting the column's
  // declared `$type` (same narrowing as `getInstalledPackageSettings`).
  const stored = row.inputSettings;

  return {
    generation: row.generationConfig ?? null,
    modelId: row.modelId ?? null,
    proxyId: row.proxyId ?? null,
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
        ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [spacePackages.spaceId, spacePackages.packageId],
        set,
      });
  });
}
