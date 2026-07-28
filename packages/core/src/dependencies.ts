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

// ─────────────────────────────────────────────
// Retired dependency vocabulary (AFPS 1.x → 2.0)
// ─────────────────────────────────────────────

/**
 * The `dependencies` map keys AFPS 1.x defined and AFPS 2.0 retired, each
 * mapped to the key that replaced it.
 *
 * A table rather than a chain of per-key `if`s so the two directions that
 * consume it — the author-input rejection ({@link findRetiredDependencyKeys},
 * folded into `validateManifest`) and the install-time warning (API layer) —
 * can never enumerate a different set, and so adding a future retirement is
 * one line here.
 *
 * These keys are NOT closed out by the schema, and deliberately so: AFPS
 * mandates extensibility for objects it does not explicitly close (§10), so
 * `dependencies` stays a loose object and `dependencies._meta` remains legal.
 * The rejection below is a POLICY on author input, not a shape constraint —
 * which is what lets already-published manifests carrying a retired key keep
 * validating (and therefore keep running) forever. See
 * {@link import("./validation.ts").RetiredRuntimeToolsPolicy}.
 */
const RETIRED_DEPENDENCY_KEYS = {
  tools: "mcp_servers",
  providers: "integrations",
} as const satisfies Record<string, keyof Dependencies>;

/** A `dependencies` map key retired by AFPS 2.0. */
export type RetiredDependencyKey = keyof typeof RETIRED_DEPENDENCY_KEYS;

/** One retired `dependencies` key found on a manifest, with its replacement. */
export interface RetiredDependencyKeyUse {
  /** The retired key as it appears in the manifest (e.g. `"tools"`). */
  key: RetiredDependencyKey;
  /** The AFPS 2.0 key that replaced it (e.g. `"mcp_servers"`). */
  replacement: keyof Dependencies;
}

/**
 * List the retired AFPS 1.x `dependencies` keys a manifest declares.
 *
 * Type-agnostic: every package type may carry `dependencies`, and the retired
 * spelling is equally inert on all of them ({@link RETIRED_DEPENDENCY_KEYS}).
 *
 * Pure and non-mutating: returns what was found, decides nothing. Callers
 * apply the direction-dependent policy — reject on author input, warn (never
 * rewrite) on already-persisted manifests.
 */
export function findRetiredDependencyKeys(manifest: unknown): RetiredDependencyKeyUse[] {
  if (typeof manifest !== "object" || manifest === null) return [];
  const deps = (manifest as { dependencies?: unknown }).dependencies;
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) return [];

  const found: RetiredDependencyKeyUse[] = [];
  for (const [key, replacement] of Object.entries(RETIRED_DEPENDENCY_KEYS)) {
    // `hasOwnProperty.call`, not `Object.hasOwn` — core is compiled against
    // the web app's older `lib` target too. Own-property only: an inherited
    // key was not authored.
    if (Object.prototype.hasOwnProperty.call(deps, key)) {
      found.push({ key: key as RetiredDependencyKey, replacement });
    }
  }
  return found;
}

/**
 * Strip the retired AFPS 1.x `dependencies` keys from an EDITABLE manifest.
 *
 * The mirror image of `dropRetiredRuntimeTools` in `validation.ts`, and used
 * for the same reason: an agent whose draft carries a retired key (imported
 * from a bundle assembled out of a legacy published version, say) would
 * otherwise round-trip it forever, and the first save through the author path
 * — where the key is rejected — would fail on a field the editor cannot even
 * display. Normalising on LOAD makes the key disappear on the next save
 * instead, while typing one into a raw-JSON tab still surfaces the rejection.
 * Nothing is lost — the key is inert ({@link RETIRED_DEPENDENCY_KEYS}).
 *
 * Purely structural: no Zod round-trip, surviving keys keep their order, and
 * the input is returned by the SAME reference when there is nothing to drop.
 * An emptied `dependencies` is left as `{}` rather than deleted — `{}` is the
 * shape the editor itself mints for a fresh agent, so both writers agree.
 *
 * NOT wired into any stored/published path — there the key is tolerated and
 * surfaced as an install warning instead.
 */
export function dropRetiredDependencyKeys(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const found = findRetiredDependencyKeys(manifest);
  if (found.length === 0) return manifest;

  const deps = { ...(manifest.dependencies as Record<string, unknown>) };
  for (const { key } of found) delete deps[key];
  return { ...manifest, dependencies: deps };
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
 * Collect the ids of every dependency a run may legitimately override via
 * `dependency_overrides` — bundled **skills** (`buildAgentPackage`) and spawned
 * **integrations** (`resolveRunIntegrationVersions`). The single source of truth
 * for the run-path override KEY gate, so skills and integrations are never
 * enumerated independently at the call site (#666/#686).
 *
 * Intentionally LENIENT (mirrors the two underlying readers): skills come from
 * `dependencies.skills` keys verbatim, integrations from
 * {@link parseManifestIntegrations}. `mcp_servers` are deliberately excluded —
 * an mcp-server is pinned via its integration's `source.server.version`, not a
 * `dependency_overrides` key (the byte route serves system/published only), so
 * an mcp-server override key must stay an unknown-key 400.
 */
export function collectOverridableDependencyIds(manifest: Record<string, unknown>): Set<string> {
  const deps = (manifest.dependencies ?? {}) as { skills?: Record<string, unknown> };
  const ids = new Set<string>();
  for (const id of Object.keys(deps.skills ?? {})) {
    if (id) ids.add(id);
  }
  for (const entry of parseManifestIntegrations(manifest)) {
    ids.add(entry.id);
  }
  return ids;
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
