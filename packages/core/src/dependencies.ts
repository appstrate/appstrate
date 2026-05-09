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
  tools?: Record<string, string>;
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
  depType: "skill" | "tool" | "provider";
  /** Semver version range (e.g. "^1.0.0"). */
  versionRange: string;
}

/**
 * Extract dependency entries from a manifest's `dependencies` field.
 * Parses scoped names from the skills, tools, and providers dependency maps.
 * @param manifest - Raw manifest object containing an optional `dependencies` field
 * @returns Array of parsed dependency entries
 * @throws Error if any dependency has an invalid scoped package name
 */
export function extractDependencies(manifest: Record<string, unknown>): DepEntry[] {
  const dependencies = manifest.dependencies as
    | {
        skills?: Record<string, string>;
        tools?: Record<string, string>;
        providers?: Record<string, string>;
      }
    | undefined;

  if (!dependencies) return [];

  const deps: DepEntry[] = [];

  const { skills = {}, tools = {}, providers = {} } = dependencies;

  const maps: [Record<string, string>, DepEntry["depType"]][] = [
    [skills, "skill"],
    [tools, "tool"],
    [providers, "provider"],
  ];

  for (const [map, depType] of maps) {
    for (const [fullName, versionRange] of Object.entries(map)) {
      const parsed = parseScopedName(fullName);
      if (!parsed) {
        throw new Error(`Invalid scoped package name: ${fullName}`);
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
