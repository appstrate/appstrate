// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { parseScopedName } from "./naming.ts";
import { getErrorMessage } from "./errors";
import { isValidRange } from "./semver.ts";
import { AFPS_1X_READ_FALLBACK_REMOVAL } from "./back-compat.ts";

// Silence unused-warning when this file is consumed without referencing the
// constant — the import exists so removal of the back-compat block is one
// `tsc` error away once the deprecation milestone ships.
void AFPS_1X_READ_FALLBACK_REMOVAL;

// ─────────────────────────────────────────────
// Dependencies shape (manifest format)
// ─────────────────────────────────────────────

/**
 * Generic dependency object form per AFPS 2.0.2 §4.1 — `version` is the
 * semver range, every other field is per-dependency-type configuration
 * (e.g. integrations carry `scopes`/`auth_key`).
 */
export interface DependencyObject {
  version: string;
  [key: string]: unknown;
}

/** Integration dependency object form (§4.1) — version + optional scopes + optional auth_key. */
export interface IntegrationDependencyObject extends DependencyObject {
  scopes?: string[];
  auth_key?: string;
}

/** Polymorphic dependency value: bare semver range string OR object form. */
export type DependencyValue = string | DependencyObject;
export type IntegrationDependencyValue = string | IntegrationDependencyObject;

/**
 * Package dependency map as declared in manifest.json. Per AFPS 2.0.2 §4.1
 * each value can be either a bare semver range or an object whose `version`
 * member is a semver range (object form is the carrier for per-dependency-type
 * configuration like `scopes`/`auth_key` for integrations).
 */
export interface Dependencies {
  skills?: Record<string, DependencyValue>;
  mcp_servers?: Record<string, DependencyValue>;
  integrations?: Record<string, IntegrationDependencyValue>;
}

// ─────────────────────────────────────────────
// Dependency extraction from manifests
// ─────────────────────────────────────────────

/** A single parsed dependency entry with scope, name, type, and version range. */
export interface DepEntry {
  /** Scope with `@` prefix (e.g. "@myorg"). */
  depScope: string;
  /** Package name without scope (e.g. "my-skill"). */
  depName: string;
  /** The dependency category. */
  depType: "skill" | "mcp-server" | "integration";
  /** Semver version range (e.g. "^1.0.0"). */
  versionRange: string;
}

/**
 * Extract a normalized version range from a polymorphic AFPS dependency
 * value. Accepts either a bare semver range string or the object form
 * `{ version, ... }` (§4.1). Returns `null` if the value can't be coerced
 * to a version string.
 */
function readVersionRange(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = (value as { version?: unknown }).version;
    if (typeof v === "string") return v;
  }
  return null;
}

/**
 * Extract dependency entries from a manifest's `dependencies` field.
 * Parses scoped names from the skills, mcp_servers, and integrations
 * dependency maps. Per AFPS 2.0.2 §4.1 each value is either a bare semver
 * range string OR an object `{ version, ... }`; this helper normalizes both
 * to a flat `DepEntry` carrying just the version range. Object-form extras
 * (e.g. `scopes`/`auth_key` for integrations) are read via
 * {@link parseManifestIntegrations}.
 * @param manifest - Raw manifest object containing an optional `dependencies` field
 * @returns Array of parsed dependency entries
 * @throws Error if any dependency has an invalid scoped package name or a
 *         value whose shape doesn't match AFPS §4.1.
 */
export function extractDependencies(manifest: Record<string, unknown>): DepEntry[] {
  const dependencies = manifest.dependencies as Dependencies | undefined;

  if (!dependencies) return [];

  const deps: DepEntry[] = [];
  const { skills = {}, mcp_servers = {}, integrations = {} } = dependencies;

  // AFPS 1.x → 2.0 read fallback (see AFPS_1X_READ_FALLBACK_REMOVAL in
  // back-compat.ts). Appendix D of the AFPS 2.0 spec maps the retired 1.x
  // dependency keys to their 2.0 equivalents:
  //   - `dependencies.providers` → `dependencies.integrations`
  //   - `dependencies.tools`     → `dependencies.mcp_servers`
  // Mirrors the `providersConfiguration` precedence pattern in
  // `parseManifestIntegrations` — canonical reads run first; legacy
  // projections are appended AFTER so canonical entries win on collision.
  const legacy = dependencies as Record<string, unknown>;
  const legacyProviders =
    legacy.providers && typeof legacy.providers === "object"
      ? (legacy.providers as Record<string, IntegrationDependencyValue>)
      : {};
  const legacyTools =
    legacy.tools && typeof legacy.tools === "object"
      ? (legacy.tools as Record<string, DependencyValue>)
      : {};

  const maps: [
    Record<string, DependencyValue | IntegrationDependencyValue>,
    DepEntry["depType"],
  ][] = [
    [skills, "skill"],
    [mcp_servers, "mcp-server"],
    [integrations, "integration"],
    // 1.x back-compat projections (canonical wins on collision — these are
    // de-duplicated by the seen-set below).
    [legacyTools, "mcp-server"],
    [legacyProviders, "integration"],
  ];

  // Track canonical entries so the 1.x projections can't double-emit a dep
  // already declared on the canonical key.
  const seen = new Set<string>();

  for (const [map, depType] of maps) {
    for (const [fullName, raw] of Object.entries(map)) {
      const parsed = parseScopedName(fullName);
      if (!parsed) {
        throw new Error(`Invalid scoped package name: ${fullName}`);
      }
      const versionRange = readVersionRange(raw);
      if (versionRange === null) {
        throw new Error(
          `Invalid dependency value for ${fullName}: expected string or { version: string, ... }, got ${typeof raw}`,
        );
      }
      if (!isValidRange(versionRange)) {
        throw new Error(
          `Invalid semver range for ${depType} dependency "${fullName}": "${versionRange}"`,
        );
      }
      const key = `${depType}:@${parsed.scope}/${parsed.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push({ depScope: `@${parsed.scope}`, depName: parsed.name, depType, versionRange });
    }
  }

  return deps;
}

// ─────────────────────────────────────────────
// Integration entries (deps version + top-level integrations selection)
// ─────────────────────────────────────────────

/**
 * Resolved view of an integration declared on an agent manifest: the
 * version range from `dependencies.integrations[id]` paired with the
 * tool/scope selection from the top-level `integrations[id]` block.
 *
 * `tools === undefined` means the agent declared the dep but didn't
 * pick any tool — the runtime treats this as "0 tools used, integration
 * effectively inert". An explicit empty array carries the same meaning;
 * the distinction is preserved only so editor round-trips don't promote
 * `undefined` to `[]` on every save.
 */
export interface ManifestIntegrationEntry {
  id: string;
  version: string;
  tools?: string[];
  scopes?: string[];
  /**
   * AFPS 2.0 §4.1 — selects which `auths.<key>` entry on the depended-on
   * integration this agent dependency uses, when the integration declares
   * multiple auth methods. `undefined` lets the runtime pick per existing
   * resolver cascade (any accessible connection on the integration).
   */
  auth_key?: string;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((s): s is string => typeof s === "string");
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve an agent manifest's per-integration configuration.
 *
 * Per AFPS 2.0.2 §4.1 / §4.4, three sources may carry per-integration
 * configuration, read in priority order — the first non-empty value for
 * each key wins:
 *
 *   1. **Canonical** — `dependencies.integrations.<id>` object form,
 *      `{ version, scopes?, auth_key?, ... }` (§4.1).
 *   2. **Deprecated alias** — `integrations_configuration.<id>` (§4.4).
 *      Consumers MUST accept this; on conflict the canonical wins.
 *   3. **Legacy back-compat read** — top-level `manifest.integrations.<id>`,
 *      an Appstrate-invented block from before AFPS 2.0.2. Used as a
 *      fall-back so existing stored manifests keep working; writers no
 *      longer emit it (see {@link writeManifestIntegrations}).
 *   4. **Pre-2.0 camelCase alias** — `providersConfiguration.<id>`. The
 *      Appstrate 1.x name for what AFPS 2.0 §4.4 calls
 *      `integrations_configuration`. Read-only fallback for manifests
 *      stored before the snake_case migration; writers emit the canonical
 *      form (which migrates the manifest forward on next save). Scheduled
 *      for removal in {@link AFPS_1X_READ_FALLBACK_REMOVAL} — at that point
 *      a one-time DB backfill on `package_versions.manifest` MUST rewrite
 *      any remaining `providersConfiguration` payloads into
 *      `integrations_configuration` (see `back-compat.ts` for the query
 *      shape), and this fallback read MUST be deleted.
 *
 * Version range always comes from `dependencies.integrations.<id>`
 * (string form OR `.version` on the object). An integration with no
 * `dependencies.integrations.<id>` entry is dropped — the dep table is
 * the canonical "is this integration declared" gate.
 */
export function parseManifestIntegrations(
  manifest: Record<string, unknown>,
): ManifestIntegrationEntry[] {
  const deps = (manifest.dependencies ?? {}) as { integrations?: Record<string, unknown> };
  const versionMap = deps.integrations ?? {};
  const deprecatedAlias = (manifest.integrations_configuration ?? {}) as Record<string, unknown>;
  const legacyTopLevel = (manifest.integrations ?? {}) as Record<string, unknown>;
  // 1.x camelCase alias of `integrations_configuration` — read-only fallback,
  // scheduled for removal in AFPS_1X_READ_FALLBACK_REMOVAL (see back-compat.ts).
  const v1CamelAlias = (manifest.providersConfiguration ?? {}) as Record<string, unknown>;

  const out: ManifestIntegrationEntry[] = [];
  for (const [id, rawDep] of Object.entries(versionMap)) {
    const version = readVersionRange(rawDep);
    if (version === null) continue;

    // Canonical object-form fields on the dep entry itself (§4.1) — highest priority.
    const depObj =
      rawDep && typeof rawDep === "object" ? (rawDep as Record<string, unknown>) : undefined;
    const aliasObj =
      deprecatedAlias[id] && typeof deprecatedAlias[id] === "object"
        ? (deprecatedAlias[id] as Record<string, unknown>)
        : undefined;
    const legacyObj =
      legacyTopLevel[id] && typeof legacyTopLevel[id] === "object"
        ? (legacyTopLevel[id] as Record<string, unknown>)
        : undefined;
    const v1Obj =
      v1CamelAlias[id] && typeof v1CamelAlias[id] === "object"
        ? (v1CamelAlias[id] as Record<string, unknown>)
        : undefined;

    // Precedence: canonical dep object > deprecated alias > legacy top-level block > v1 camelCase alias.
    const scopes =
      toStringArray(depObj?.scopes) ??
      toStringArray(aliasObj?.scopes) ??
      toStringArray(legacyObj?.scopes) ??
      toStringArray(v1Obj?.scopes);
    // `tools[]` is an Appstrate extension (no AFPS field of this name) — read
    // from the same merged sources so editor round-trips don't lose the
    // selection. `auth_key` likewise can come from any of the four.
    const tools =
      toStringArray(depObj?.tools) ??
      toStringArray(aliasObj?.tools) ??
      toStringArray(legacyObj?.tools) ??
      toStringArray(v1Obj?.tools);
    // `auth_key` (§4.1) — string pointing at one of the integration's
    // `auths.<key>` entries. Mirrors the same precedence cascade as
    // `scopes` / `tools`: canonical dep object > deprecated alias > legacy
    // top-level block > v1 camelCase alias.
    const auth_key =
      pickString(depObj?.auth_key) ??
      pickString(aliasObj?.auth_key) ??
      pickString(legacyObj?.auth_key) ??
      pickString(v1Obj?.auth_key);

    out.push({ id, version: version || "*", tools, scopes, auth_key });
  }
  return out;
}

/**
 * Write integration entries back to a manifest using the AFPS 2.0.2 §4.1
 * canonical inline object form: each `dependencies.integrations.<id>`
 * becomes `{ version, scopes?, auth_key?, tools? }`. Entries with no
 * per-integration configuration collapse to a bare semver string for
 * minimal manifests.
 *
 * Drops the deprecated `integrations_configuration` alias (§4.4) and the
 * Appstrate-invented top-level `manifest.integrations.<id>` block — both
 * are merged back in on read by {@link parseManifestIntegrations} for
 * back-compat, but writers emit only the canonical form so newly-saved
 * manifests round-trip clean against AFPS validators.
 *
 * Note: `tools[]` is an Appstrate extension key with no AFPS field of the
 * same name. AFPS dependency entries are `looseObject`s (§4.1), so the
 * extra key round-trips through the canonical schema unchanged.
 */
export function writeManifestIntegrations(
  manifest: Record<string, unknown>,
  entries: readonly ManifestIntegrationEntry[],
): void {
  if (!manifest.dependencies) manifest.dependencies = {};
  const deps = manifest.dependencies as Record<string, unknown>;
  const integrationMap: Record<string, IntegrationDependencyValue> = {};

  for (const e of entries) {
    if (!e.id) continue;
    const version = e.version || "*";
    const hasTools = e.tools !== undefined;
    const hasScopes = Array.isArray(e.scopes) && e.scopes.length > 0;
    const hasAuthKey = typeof e.auth_key === "string" && e.auth_key.length > 0;

    if (!hasTools && !hasScopes && !hasAuthKey) {
      // Minimal entry — collapse to bare version string per §4.1.
      integrationMap[e.id] = version;
    } else {
      integrationMap[e.id] = {
        version,
        ...(hasScopes ? { scopes: [...e.scopes!] } : {}),
        ...(hasTools ? { tools: [...e.tools!] } : {}),
        ...(hasAuthKey ? { auth_key: e.auth_key! } : {}),
      };
    }
  }

  if (Object.keys(integrationMap).length > 0) {
    deps.integrations = integrationMap;
  } else {
    delete deps.integrations;
  }
  // Drop legacy/deprecated alternates — they are read for back-compat in
  // parseManifestIntegrations but the canonical form is the single writer.
  delete manifest.integrations;
  delete manifest.integrations_configuration;
  // 1.x camelCase alias — same back-compat read path, single writer migrates.
  // Removal tracked by AFPS_1X_READ_FALLBACK_REMOVAL (see back-compat.ts).
  delete (manifest as Record<string, unknown>).providersConfiguration;
}

/** Result of circular dependency detection. */
export interface CycleCheckResult {
  /** Whether a circular dependency was detected. */
  hasCycle: boolean;
  /** The cycle path if found, e.g. ["@a/pkg", "@b/pkg", "@a/pkg"]. */
  cyclePath?: string[];
  /** Errors encountered while resolving transitive dependencies. */
  resolveErrors: string[];
}

/**
 * BFS-based circular dependency detection.
 * @param publishingId — The package being published/installed (e.g. "@scope/name")
 * @param directDeps — Its direct dependencies
 * @param resolveDeps — Async callback to fetch transitive deps of a package
 */
export async function detectCycle(
  publishingId: string,
  directDeps: DepEntry[],
  resolveDeps: (scope: string, name: string) => Promise<DepEntry[]>,
): Promise<CycleCheckResult> {
  const resolveErrors: string[] = [];

  // Fast path: self-reference
  for (const dep of directDeps) {
    const depId = `${dep.depScope}/${dep.depName}`;
    if (depId === publishingId) {
      return { hasCycle: true, cyclePath: [publishingId, depId], resolveErrors };
    }
  }

  // BFS traversal
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue: string[] = directDeps.map((d) => `${d.depScope}/${d.depName}`);

  for (const depId of queue) {
    parent.set(depId, publishingId);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    // Parse scope/name from the key (format: "@scope/name")
    const slashIdx = current.indexOf("/", 1); // skip @ prefix
    if (slashIdx === -1) continue;
    const scope = current.slice(0, slashIdx);
    const name = current.slice(slashIdx + 1);

    let transitiveDeps: DepEntry[];
    try {
      transitiveDeps = await resolveDeps(scope, name);
    } catch (err) {
      resolveErrors.push(`Failed to resolve deps for ${current}: ${getErrorMessage(err)}`);
      continue;
    }

    for (const dep of transitiveDeps) {
      const depId = `${dep.depScope}/${dep.depName}`;

      if (depId === publishingId) {
        // Reconstruct cycle path
        const path: string[] = [publishingId];
        let node: string | undefined = current;
        const chain: string[] = [];
        while (node && node !== publishingId) {
          chain.unshift(node);
          node = parent.get(node);
        }
        path.push(...chain, depId);
        return { hasCycle: true, cyclePath: path, resolveErrors };
      }

      if (!visited.has(depId)) {
        queue.push(depId);
        if (!parent.has(depId)) {
          parent.set(depId, current);
        }
      }
    }
  }

  return { hasCycle: false, resolveErrors };
}
