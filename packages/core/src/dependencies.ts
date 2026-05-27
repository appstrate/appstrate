// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { parseScopedName } from "./naming.ts";
import { getErrorMessage } from "./errors";
import { isValidRange } from "./semver.ts";

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
// Publish-time guard against legacy 1.x dep keys
// ─────────────────────────────────────────────

/**
 * Error thrown by {@link assertNoLegacyDepKeys} when a manifest carries the
 * retired AFPS 1.x dependency keys (`dependencies.providers` /
 * `dependencies.tools`). Per AFPS 2.0 §2.1 / Appendix D, producers MUST NOT
 * emit these keys — they were renamed to `dependencies.integrations` and
 * `dependencies.mcp_servers`. The publish path calls this guard to reject
 * newly-emitted legacy shapes.
 */
export class LegacyDepKeyError extends Error {
  /** Manifest field path that triggered the rejection (e.g. `"dependencies.providers"`). */
  public readonly field: string;
  /** Canonical AFPS 2.0 key that should be used instead. */
  public readonly suggestedRename: string;

  constructor(field: string, suggestedRename: string) {
    super(
      `${field} is a retired AFPS 1.x dependency key — producers MUST NOT emit it per AFPS 2.0 §2.1 / Appendix D. Rename to "${suggestedRename}".`,
    );
    this.name = "LegacyDepKeyError";
    this.field = field;
    this.suggestedRename = suggestedRename;
  }
}

/**
 * Publish-time guard: reject manifests that carry the retired AFPS 1.x
 * dependency keys (`dependencies.providers`, `dependencies.tools`). Per
 * AFPS 2.0 §2.1 + Appendix D, producers MUST NOT emit these keys; they map
 * to `dependencies.integrations` and `dependencies.mcp_servers` respectively.
 *
 * Call this from the publish path BEFORE persisting a new version row.
 *
 * @throws LegacyDepKeyError when a legacy key is detected on the manifest.
 */
export function assertNoLegacyDepKeys(manifest: Record<string, unknown>): void {
  const deps = manifest.dependencies;
  if (!deps || typeof deps !== "object") return;
  const legacy = deps as Record<string, unknown>;
  if (legacy.providers !== undefined) {
    throw new LegacyDepKeyError("dependencies.providers", "dependencies.integrations");
  }
  if (legacy.tools !== undefined) {
    throw new LegacyDepKeyError("dependencies.tools", "dependencies.mcp_servers");
  }
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

  const maps: [
    Record<string, DependencyValue | IntegrationDependencyValue>,
    DepEntry["depType"],
  ][] = [
    [skills, "skill"],
    [mcp_servers, "mcp-server"],
    [integrations, "integration"],
  ];

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
 * Per AFPS 2.0.2 §4.1, per-integration configuration lives on the canonical
 * `dependencies.integrations.<id>` object form,
 * `{ version, scopes?, auth_key?, tools?, ... }`.
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

  const out: ManifestIntegrationEntry[] = [];
  for (const [id, rawDep] of Object.entries(versionMap)) {
    const version = readVersionRange(rawDep);
    if (version === null) continue;

    // Canonical object-form fields on the dep entry itself (§4.1).
    const depObj =
      rawDep && typeof rawDep === "object" ? (rawDep as Record<string, unknown>) : undefined;

    const scopes = toStringArray(depObj?.scopes);
    // `tools[]` is an Appstrate extension (no AFPS field of this name).
    const tools = toStringArray(depObj?.tools);
    // `auth_key` (§4.1) — string pointing at one of the integration's
    // `auths.<key>` entries.
    const auth_key = pickString(depObj?.auth_key);

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
