// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { parseScopedName } from "./naming.ts";
import { getErrorMessage } from "./errors";

// ─────────────────────────────────────────────
// Dependencies shape (manifest format)
// ─────────────────────────────────────────────

/** Package dependency map as declared in manifest.json, keyed by scoped package name to version range. */
export interface Dependencies {
  skills?: Record<string, string>;
  providers?: Record<string, string>;
}

// ─────────────────────────────────────────────
// Dependency extraction from manifests
// ─────────────────────────────────────────────

/** A single parsed dependency entry with scope, name, type, and version range. */
export interface DepEntry {
  /** Scope with `@` prefix (e.g. "@myorg"). */
  depScope: string;
  /** Package name without scope (e.g. "my-tool"). */
  depName: string;
  /** The dependency category. */
  depType: "skill" | "provider" | "integration";
  /** Semver version range (e.g. "^1.0.0"). */
  versionRange: string;
}

/**
 * Extract dependency entries from a manifest's `dependencies` field.
 * Parses scoped names from the skills, providers, and integrations
 * dependency maps. Every dependency value is a bare semver range string.
 * Per-integration tool/scope selection lives in the manifest's top-level
 * `integrations[id]` block — read via {@link parseManifestIntegrations}.
 * @param manifest - Raw manifest object containing an optional `dependencies` field
 * @returns Array of parsed dependency entries
 * @throws Error if any dependency has an invalid scoped package name
 */
export function extractDependencies(manifest: Record<string, unknown>): DepEntry[] {
  const dependencies = manifest.dependencies as
    | {
        skills?: Record<string, string>;
        providers?: Record<string, string>;
        integrations?: Record<string, string>;
      }
    | undefined;

  if (!dependencies) return [];

  const deps: DepEntry[] = [];
  const { skills = {}, providers = {}, integrations = {} } = dependencies;

  const maps: [Record<string, string>, DepEntry["depType"]][] = [
    [skills, "skill"],
    [providers, "provider"],
    [integrations, "integration"],
  ];

  for (const [map, depType] of maps) {
    for (const [fullName, versionRange] of Object.entries(map)) {
      const parsed = parseScopedName(fullName);
      if (!parsed) {
        throw new Error(`Invalid scoped package name: ${fullName}`);
      }
      if (typeof versionRange !== "string") {
        throw new Error(
          `Invalid version for ${fullName}: expected string, got ${typeof versionRange}`,
        );
      }
      deps.push({ depScope: `@${parsed.scope}`, depName: parsed.name, depType, versionRange });
    }
  }

  return deps;
}

// ─────────────────────────────────────────────
// Provider entries (manifest.dependencies.providers + providersConfiguration)
// ─────────────────────────────────────────────

/**
 * A single provider entry as it appears in a manifest: the dependency
 * identifier (`@scope/name`), the declared version range, and optional
 * OAuth scopes from `providersConfiguration`.
 */
export interface ManifestProviderEntry {
  id: string;
  version: string;
  scopes: string[];
}

/** Read providers + providersConfiguration into a flat ManifestProviderEntry[]. */
export function parseManifestProviders(manifest: Record<string, unknown>): ManifestProviderEntry[] {
  const deps = (manifest.dependencies ?? {}) as { providers?: Record<string, string> };
  const providers = deps.providers ?? {};
  const config = (manifest.providersConfiguration ?? {}) as Record<string, { scopes?: unknown }>;
  return Object.entries(providers).map(([id, version]) => {
    const scopes = config[id]?.scopes;
    return {
      id,
      version: version || "*",
      scopes: Array.isArray(scopes)
        ? (scopes as string[]).filter((s) => typeof s === "string")
        : [],
    };
  });
}

/**
 * Write a list of ManifestProviderEntry back into a manifest, mutating
 * `manifest.dependencies.providers` and `manifest.providersConfiguration`
 * in place. Used by the agent editor when the user updates the providers
 * panel — pairs with `parseManifestProviders` for round-tripping.
 */
export function writeManifestProviders(
  manifest: Record<string, unknown>,
  entries: ManifestProviderEntry[],
): void {
  if (!manifest.dependencies) manifest.dependencies = { providers: {} };
  const deps = manifest.dependencies as Record<string, unknown>;
  const providers: Record<string, string> = {};
  const config: Record<string, Record<string, unknown>> = {};
  for (const e of entries) {
    if (!e.id) continue;
    providers[e.id] = e.version;
    const scopes = (e.scopes ?? []).filter(Boolean);
    if (scopes.length > 0) config[e.id] = { scopes };
  }
  deps.providers = providers;
  if (Object.keys(config).length > 0) {
    manifest.providersConfiguration = config;
  } else {
    delete manifest.providersConfiguration;
  }
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
}

/**
 * Merge an agent manifest's `dependencies.integrations` (version) with
 * its top-level `integrations` (tool/scope selection). Counterpart of
 * {@link parseManifestProviders} for integrations.
 */
export function parseManifestIntegrations(
  manifest: Record<string, unknown>,
): ManifestIntegrationEntry[] {
  const deps = (manifest.dependencies ?? {}) as { integrations?: Record<string, unknown> };
  const versionMap = deps.integrations ?? {};
  const selections = (manifest.integrations ?? {}) as Record<string, unknown>;
  const out: ManifestIntegrationEntry[] = [];
  for (const [id, version] of Object.entries(versionMap)) {
    if (typeof version !== "string") continue;
    const sel = selections[id];
    const selObj = sel && typeof sel === "object" ? (sel as Record<string, unknown>) : undefined;
    const tools = Array.isArray(selObj?.tools)
      ? (selObj!.tools as unknown[]).filter((t): t is string => typeof t === "string")
      : undefined;
    const scopes = Array.isArray(selObj?.scopes)
      ? (selObj!.scopes as unknown[]).filter((s): s is string => typeof s === "string")
      : undefined;
    out.push({ id, version: version || "*", tools, scopes });
  }
  return out;
}

/**
 * Write integration entries back to a manifest: `dependencies.integrations`
 * carries the bare version map; the top-level `integrations` block
 * carries per-id `{ tools?, scopes? }` only when the agent actually
 * picked something. Pairs with {@link parseManifestIntegrations}.
 */
export function writeManifestIntegrations(
  manifest: Record<string, unknown>,
  entries: readonly ManifestIntegrationEntry[],
): void {
  if (!manifest.dependencies) manifest.dependencies = {};
  const deps = manifest.dependencies as Record<string, unknown>;
  const versionMap: Record<string, string> = {};
  const selectionMap: Record<string, { tools?: string[]; scopes?: string[] }> = {};
  for (const e of entries) {
    if (!e.id) continue;
    versionMap[e.id] = e.version || "*";
    const hasTools = e.tools !== undefined;
    const hasScopes = Array.isArray(e.scopes) && e.scopes.length > 0;
    if (hasTools || hasScopes) {
      selectionMap[e.id] = {
        ...(hasTools ? { tools: [...e.tools!] } : {}),
        ...(hasScopes ? { scopes: [...e.scopes!] } : {}),
      };
    }
  }
  if (Object.keys(versionMap).length > 0) {
    deps.integrations = versionMap;
  } else {
    delete deps.integrations;
  }
  if (Object.keys(selectionMap).length > 0) {
    manifest.integrations = selectionMap;
  } else {
    delete manifest.integrations;
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
