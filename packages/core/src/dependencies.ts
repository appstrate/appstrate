// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { parseScopedName } from "./naming.ts";
import { getErrorMessage } from "./errors";
import { isValidRange } from "./semver.ts";

// ─────────────────────────────────────────────
// Dependencies shape (manifest format)
// ─────────────────────────────────────────────

/**
 * Package dependency maps as declared in manifest.json (AFPS §4.1). Each
 * value is a bare semver range string — the maps declare which packages are
 * depended on and at what versions, nothing more. Per-integration agent
 * configuration lives in the top-level `integrations_configuration` map
 * ({@link IntegrationsConfiguration}, AFPS §4.4).
 */
export interface Dependencies {
  skills?: Record<string, string>;
  mcp_servers?: Record<string, string>;
  integrations?: Record<string, string>;
}

/**
 * Wildcard literal for {@link IntegrationConfiguration.tools} / {@link
 * ManifestIntegrationEntry.tools} (AFPS §4.4). When set, the agent forgoes
 * per-tool selection and accepts every tool the upstream MCP server
 * advertises at runtime. Requires the referenced integration to declare
 * `allow_undeclared_tools: true` (validated downstream).
 */
export const TOOLS_WILDCARD = "*" as const;
export type ToolsWildcard = typeof TOOLS_WILDCARD;

/**
 * Per-integration agent configuration (AFPS §4.4), keyed by integration
 * dependency id. Each key MUST correspond to an entry in
 * `dependencies.integrations`. `tools` drives the runtime allowlist + OAuth
 * scope inference; `scopes` is the explicit escape hatch; `auth_key`
 * disambiguates a multi-auth integration.
 *
 * `tools` accepts the wildcard literal `"*"` to opt the agent into all
 * upstream tools (zero-trust preserved: the integration must opt in via
 * `allow_undeclared_tools: true`).
 */
export interface IntegrationConfiguration {
  tools?: string[] | ToolsWildcard;
  scopes?: string[];
  auth_key?: string;
}

/** The agent manifest's `integrations_configuration` map (AFPS §4.4). */
export type IntegrationsConfiguration = Record<string, IntegrationConfiguration>;

// ─────────────────────────────────────────────
// Publish-time guard against legacy 1.x dep keys
// ─────────────────────────────────────────────

/**
 * Error thrown by {@link assertNoLegacyDepKeys} when a manifest carries the
 * retired AFPS 1.x dependency keys (`dependencies.providers` /
 * `dependencies.tools`). Per AFPS §2.1 / Appendix D, producers MUST NOT
 * emit these keys — they were renamed to `dependencies.integrations` and
 * `dependencies.mcp_servers`. The publish path calls this guard to reject
 * newly-emitted legacy shapes.
 */
export class LegacyDepKeyError extends Error {
  /** Manifest field path that triggered the rejection (e.g. `"dependencies.providers"`). */
  public readonly field: string;
  /** Canonical AFPS key that should be used instead. */
  public readonly suggestedRename: string;

  constructor(field: string, suggestedRename: string) {
    super(
      `${field} is a retired AFPS 1.x dependency key — producers MUST NOT emit it per AFPS §2.1 / Appendix D. Rename to "${suggestedRename}".`,
    );
    this.name = "LegacyDepKeyError";
    this.field = field;
    this.suggestedRename = suggestedRename;
  }
}

/**
 * Publish-time guard: reject manifests that carry the retired AFPS 1.x
 * dependency keys (`dependencies.providers`, `dependencies.tools`). Per
 * AFPS §2.1 + Appendix D, producers MUST NOT emit these keys; they map
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
 * Extract dependency entries from a manifest's `dependencies` field.
 * Parses scoped names from the skills, mcp_servers, and integrations
 * dependency maps. Per AFPS §4.1 each value is a bare semver range string.
 * Per-integration agent configuration (`tools`/`scopes`/`auth_key`) lives in
 * the top-level `integrations_configuration` map and is read via
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

  const maps: [Record<string, string>, DepEntry["depType"]][] = [
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
      if (typeof raw !== "string") {
        throw new Error(
          `Invalid dependency value for ${fullName}: expected a semver range string, got ${typeof raw}`,
        );
      }
      if (!isValidRange(raw)) {
        throw new Error(`Invalid semver range for ${depType} dependency "${fullName}": "${raw}"`);
      }
      deps.push({ depScope: `@${parsed.scope}`, depName: parsed.name, depType, versionRange: raw });
    }
  }

  return deps;
}

// ─────────────────────────────────────────────
// Integration entries (deps version + integrations_configuration)
// ─────────────────────────────────────────────

/**
 * Resolved view of an integration declared on an agent manifest: the
 * version range from `dependencies.integrations[id]` (§4.1) merged with the
 * tool/scope/auth selection from `integrations_configuration[id]` (§4.4).
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
  /**
   * Per-tool selection (§4.4) — either an array of tool names the agent
   * consumes, or the wildcard literal {@link TOOLS_WILDCARD} (`"*"`) to opt
   * the agent into all upstream tools. The wildcard form requires the
   * integration to declare `allow_undeclared_tools: true`.
   */
  tools?: string[] | ToolsWildcard;
  scopes?: string[];
  /**
   * AFPS §4.4 — selects which `auths.<key>` entry on the depended-on
   * integration this agent uses, when the integration declares multiple
   * auth methods. `undefined` lets the runtime pick per existing resolver
   * cascade (any accessible connection on the integration).
   */
  auth_key?: string;
}

/** Type guard — `tools` field is the AFPS wildcard literal. */
export function isToolsWildcard(value: unknown): value is ToolsWildcard {
  return value === TOOLS_WILDCARD;
}

function toToolsField(value: unknown): string[] | ToolsWildcard | undefined {
  if (isToolsWildcard(value)) return TOOLS_WILDCARD;
  if (!Array.isArray(value)) return undefined;
  return value.filter((s): s is string => typeof s === "string");
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
 * The version range comes from `dependencies.integrations.<id>` (a bare
 * semver range string, §4.1). The tool/scope/auth selection comes from the
 * top-level `integrations_configuration.<id>` map (§4.4).
 *
 * `dependencies.integrations` is the canonical "is this integration declared"
 * gate: an integration with no dependency entry is dropped, and any
 * `integrations_configuration` entry without a matching dependency is
 * ignored here (it is rejected at manifest validation).
 */
export function parseManifestIntegrations(
  manifest: Record<string, unknown>,
): ManifestIntegrationEntry[] {
  const deps = (manifest.dependencies ?? {}) as { integrations?: Record<string, unknown> };
  const versionMap = deps.integrations ?? {};
  const configMap = (manifest.integrations_configuration ?? {}) as Record<string, unknown>;

  const out: ManifestIntegrationEntry[] = [];
  for (const [id, rawVersion] of Object.entries(versionMap)) {
    if (typeof rawVersion !== "string") continue;

    const config =
      configMap[id] && typeof configMap[id] === "object"
        ? (configMap[id] as Record<string, unknown>)
        : undefined;

    out.push({
      id,
      version: rawVersion || "*",
      tools: toToolsField(config?.tools),
      scopes: toStringArray(config?.scopes),
      auth_key: pickString(config?.auth_key),
    });
  }
  return out;
}

/**
 * Write integration entries back to a manifest in the AFPS split form:
 * the semver range goes to `dependencies.integrations.<id>` (a bare string,
 * §4.1) and the per-integration configuration goes to
 * `integrations_configuration.<id>` ({ tools?, scopes?, auth_key? }, §4.4).
 * Entries with no configuration leave no `integrations_configuration` entry.
 */
export function writeManifestIntegrations(
  manifest: Record<string, unknown>,
  entries: readonly ManifestIntegrationEntry[],
): void {
  if (!manifest.dependencies) manifest.dependencies = {};
  const deps = manifest.dependencies as Record<string, unknown>;
  const integrationMap: Record<string, string> = {};
  const configMap: IntegrationsConfiguration = {};

  for (const e of entries) {
    if (!e.id) continue;
    integrationMap[e.id] = e.version || "*";

    const hasTools = e.tools !== undefined;
    const hasScopes = Array.isArray(e.scopes) && e.scopes.length > 0;
    const hasAuthKey = typeof e.auth_key === "string" && e.auth_key.length > 0;

    if (hasTools || hasScopes || hasAuthKey) {
      configMap[e.id] = {
        ...(hasTools
          ? { tools: isToolsWildcard(e.tools) ? TOOLS_WILDCARD : [...(e.tools as string[])] }
          : {}),
        ...(hasScopes ? { scopes: [...e.scopes!] } : {}),
        ...(hasAuthKey ? { auth_key: e.auth_key! } : {}),
      };
    }
  }

  if (Object.keys(integrationMap).length > 0) {
    deps.integrations = integrationMap;
  } else {
    delete deps.integrations;
  }

  if (Object.keys(configMap).length > 0) {
    manifest.integrations_configuration = configMap;
  } else {
    delete manifest.integrations_configuration;
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
