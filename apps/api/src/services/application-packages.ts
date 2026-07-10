// SPDX-License-Identifier: Apache-2.0

/**
 * Application-level package management — install, uninstall, list, and configure
 * packages within an application context.
 */

import { eq, and, or, sql, isNotNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applicationPackages,
  packages,
  packageVersions,
  packageDistTags,
} from "@appstrate/db/schema";
import { notFound, conflict } from "../lib/errors.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { PackageType } from "@appstrate/core/validation";
import type { ResolvedRunConfig } from "@appstrate/shared-types";
import type { AppScope } from "../lib/scope.ts";
import { assertApplicationInScope } from "./applications.ts";

export type { ResolvedRunConfig };

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

export async function installPackage(
  scope: AppScope,
  packageId: string,
  config?: Record<string, unknown>,
) {
  await assertApplicationInScope(scope);

  // The org-visibility check and the insert run in ONE transaction so the
  // tenant boundary is atomic with the write — a separate preflight would
  // leave a window where an `application_packages` row could be grafted onto
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
      .select({ packageId: applicationPackages.packageId })
      .from(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, scope.applicationId),
          eq(applicationPackages.packageId, packageId),
        ),
      )
      .limit(1);

    if (existing) {
      throw conflict(
        "already_installed",
        `Package '${packageId}' is already installed in this application`,
      );
    }

    const [row] = await tx
      .insert(applicationPackages)
      .values({
        applicationId: scope.applicationId,
        packageId,
        config: config ?? {},
      })
      .returning();

    return row!;
  });
}

export async function uninstallPackage(scope: AppScope, packageId: string): Promise<void> {
  const deleted = await db
    .delete(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, scope.applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .returning({ packageId: applicationPackages.packageId });

  if (deleted.length === 0) {
    throw notFound(`Package '${packageId}' is not installed in this application`);
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const installedPackageSelect = {
  packageId: applicationPackages.packageId,
  config: applicationPackages.config,
  modelId: applicationPackages.modelId,
  proxyId: applicationPackages.proxyId,
  version_id: applicationPackages.versionId,
  enabled: applicationPackages.enabled,
  installed_at: applicationPackages.installedAt,
  updatedAt: applicationPackages.updatedAt,
  package_type: packages.type,
  package_source: packages.source,
  draft_manifest: packages.draftManifest,
};

export async function listInstalledPackages(scope: AppScope, type?: PackageType) {
  const conditions = [eq(applicationPackages.applicationId, scope.applicationId)];
  if (type) {
    conditions.push(eq(packages.type, type));
  }

  return db
    .select(installedPackageSelect)
    .from(applicationPackages)
    .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
    .where(and(...conditions));
}

export async function getInstalledPackage(scope: AppScope, packageId: string) {
  // `orgOrSystemFilter` lands in the SQL WHERE so this can never act as a
  // cross-tenant existence/type oracle: a stray association row pointing at
  // another org's package id resolves to `null`, exactly like a package that
  // does not exist.
  const [row] = await db
    .select(installedPackageSelect)
    .from(applicationPackages)
    .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
    .where(
      and(
        eq(applicationPackages.applicationId, scope.applicationId),
        eq(applicationPackages.packageId, packageId),
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
 * List all packages accessible to an application, filtered by type.
 * Accessible = system packages (always visible) + explicitly installed in application_packages.
 * Single query via LEFT JOIN — no N+1.
 */
export async function listAccessiblePackages(scope: AppScope, type: PackageType) {
  return db
    .select({
      id: packages.id,
      type: packages.type,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      source: packages.source,
      // application_packages columns (null for system packages)
      appConfig: applicationPackages.config,
      appModelId: applicationPackages.modelId,
      appProxyId: applicationPackages.proxyId,
      appVersionId: applicationPackages.versionId,
      appEnabled: applicationPackages.enabled,
      // `latest` dist-tag version id — non-null iff the package has a published
      // version. Lets callers tell published agents from draft-only ones without
      // an N+1 (a draft-only agent must be run with `version=draft`).
      latestVersionId: packageDistTags.versionId,
    })
    .from(packages)
    .leftJoin(
      applicationPackages,
      and(
        eq(applicationPackages.packageId, packages.id),
        eq(applicationPackages.applicationId, scope.applicationId),
      ),
    )
    .leftJoin(
      packageDistTags,
      and(eq(packageDistTags.packageId, packages.id), eq(packageDistTags.tag, "latest")),
    )
    .where(
      and(
        eq(packages.type, type),
        orgOrSystemFilter(scope.orgId),
        notEphemeralFilter(),
        // system packages always visible, local packages only if installed
        or(eq(packages.source, "system"), isNotNull(applicationPackages.packageId)),
      ),
    )
    .orderBy(sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`);
}

// ---------------------------------------------------------------------------
// Installed-package hints — caller-context for the chat / get_me payload
// ---------------------------------------------------------------------------

/**
 * Fields shared by every installed-package hint (agents, skills, …). Per-type
 * extras (an agent's `takes_input`, a skill's `version`) are layered on top by
 * the projection passed to `listInstalledPackageHints`.
 */
export interface PackageHint {
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
 * List the packages of one `type` an actor in this application could use, as a
 * bounded hint for the get_me / chat-prompt caller context. "Installed" =
 * visible in the app (`listAccessiblePackages`) AND not disabled per-app. System
 * packages are always enabled. The list is capped (`limit`) so a large catalog
 * doesn't bloat the system prompt — the long tail stays reachable via
 * `search_operations`.
 *
 * The base hint (id/name/description/source) is uniform across package types;
 * `project` layers on the type-specific extras from the manifest. Access gating
 * is NOT enforced here — the caller decides whether to surface the hint, and the
 * run / inline-run route re-validates at invoke time.
 */
async function listInstalledPackageHints<T extends PackageHint>(
  scope: AppScope,
  type: PackageType,
  project: (base: PackageHint, manifest: Record<string, unknown>) => T,
  opts?: { limit?: number },
): Promise<{ items: T[]; truncated: boolean; total: number }> {
  const limit = opts?.limit ?? DEFAULT_PACKAGE_HINT_LIMIT;
  const rows = await listAccessiblePackages(scope, type);

  // `enabled` is null for system packages (no application_packages row) — treat
  // null as enabled; only an explicit `false` disables a local install.
  const enabled = rows.filter((r) => r.appEnabled !== false);
  const total = enabled.length;

  const items = enabled.slice(0, limit).map((row) => {
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
export interface RunnableAgent extends PackageHint {
  /** Whether the agent declares an input schema with at least one property. */
  takes_input: boolean;
}

export interface RunnableAgentsResult {
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
  scope: AppScope,
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
export interface InstalledSkill extends PackageHint {
  /** The skill package's own manifest version, when known — pin a satisfiable
   * `dependencies.skills` range from it. */
  version: string | null;
}

export interface InstalledSkillsResult {
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
  scope: AppScope,
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
 * Check if an application has access to a specific package.
 * System packages are always accessible; local packages require installation.
 */
export async function hasPackageAccess(scope: AppScope, packageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: packages.id })
    .from(packages)
    .leftJoin(
      applicationPackages,
      and(
        eq(applicationPackages.packageId, packages.id),
        eq(applicationPackages.applicationId, scope.applicationId),
      ),
    )
    .where(
      and(
        eq(packages.id, packageId),
        notEphemeralFilter(),
        or(eq(packages.source, "system"), isNotNull(applicationPackages.packageId)),
      ),
    )
    .limit(1);

  return !!row;
}

// ---------------------------------------------------------------------------
// Package Config (per-app) — single source of truth for config/model/proxy/profile
// ---------------------------------------------------------------------------

export async function getPackageConfig(
  applicationId: string,
  packageId: string,
): Promise<{
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
}> {
  const [row] = await db
    .select({
      config: applicationPackages.config,
      modelId: applicationPackages.modelId,
      proxyId: applicationPackages.proxyId,
    })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .limit(1);
  return {
    config: asRecord(row?.config),
    modelId: row?.modelId ?? null,
    proxyId: row?.proxyId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Config Updates
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Resolved run-config — single source of truth for both the UI's per-app
// agent run and the CLI's `appstrate run @scope/agent` invocation. The
// CLI reads this endpoint after profile resolution to reproduce the UI
// run byte-for-byte (same model, proxy, config, version pin) unless the
// user passed an explicit override flag.
//
// Wire shape lives in `@appstrate/shared-types` so the CLI consumes the
// same interface without redeclaring it.
// ---------------------------------------------------------------------------

/**
 * Resolve the per-application run configuration for `(applicationId,
 * packageId)`. Returns `null` when no `application_packages` row exists
 * for the pair — the caller (route or CLI) decides whether that is a
 * 404 or a "no inheritance, fall back to flags + defaults" signal.
 *
 * The org filter lands in the SQL WHERE (`orgOrSystemFilter`) so a stray
 * association row pointing at another org's package id resolves to `null`
 * instead of leaking its config/model/proxy/version pin.
 */
export async function getResolvedRunConfig(
  scope: AppScope,
  packageId: string,
): Promise<ResolvedRunConfig | null> {
  const [row] = await db
    .select({
      config: applicationPackages.config,
      modelId: applicationPackages.modelId,
      proxyId: applicationPackages.proxyId,
      versionId: applicationPackages.versionId,
      draftManifest: packages.draftManifest,
    })
    .from(applicationPackages)
    .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
    .where(
      and(
        eq(applicationPackages.applicationId, scope.applicationId),
        eq(applicationPackages.packageId, packageId),
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

  return {
    config: asRecord(row.config),
    modelId: row.modelId ?? null,
    proxyId: row.proxyId ?? null,
    version_pin: versionPin,
  };
}

/**
 * Update the per-app settings row for `(applicationId, packageId)`.
 *
 * The org-visibility check runs in the SAME transaction as the write — never
 * as a separate preflight — so the write can never graft an
 * `application_packages` row onto a package id the org cannot see (another
 * org's package, or an ephemeral shadow row).
 *
 * Two modes:
 *   - `requireInstalled: true` (the public
 *     `PUT /applications/:id/packages/:packageId` route): the association row
 *     MUST already exist — an update that would create a new row is a client
 *     error (404), never an implicit install.
 *   - default (agent config/proxy/model routes, integration activate /
 *     deactivate): upsert. A SYSTEM package legitimately has no
 *     `application_packages` row until its first per-app setting is written,
 *     so create-on-first-write is intended there. Those routes preflight the
 *     package via `requireAgent()` / `assertIsIntegration()`; the in-transaction
 *     check below re-enforces the same boundary atomically.
 */
export async function updateInstalledPackage(
  scope: AppScope,
  packageId: string,
  updates: {
    config?: Record<string, unknown>;
    modelId?: string | null;
    proxyId?: string | null;
    versionId?: number | null;
    enabled?: boolean;
  },
  opts?: { requireInstalled?: boolean },
): Promise<void> {
  const set: Partial<{
    updatedAt: Date;
    config: Record<string, unknown>;
    modelId: string | null;
    proxyId: string | null;
    versionId: number | null;
    enabled: boolean;
  }> = { updatedAt: new Date() };
  if (updates.config !== undefined) set.config = updates.config;
  if (updates.modelId !== undefined) set.modelId = updates.modelId;
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
        .update(applicationPackages)
        .set(set)
        .where(
          and(
            eq(applicationPackages.applicationId, scope.applicationId),
            eq(applicationPackages.packageId, packageId),
          ),
        )
        .returning({ packageId: applicationPackages.packageId });
      if (updated.length === 0) {
        throw notFound(`Package '${packageId}' is not installed in this application`);
      }
      return;
    }

    await tx
      .insert(applicationPackages)
      .values({
        applicationId: scope.applicationId,
        packageId,
        config: updates.config ?? {},
        ...(updates.modelId !== undefined ? { modelId: updates.modelId } : {}),
        ...(updates.proxyId !== undefined ? { proxyId: updates.proxyId } : {}),
        ...(updates.versionId !== undefined ? { versionId: updates.versionId } : {}),
        ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [applicationPackages.applicationId, applicationPackages.packageId],
        set,
      });
  });
}
