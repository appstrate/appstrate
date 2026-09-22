// SPDX-License-Identifier: Apache-2.0

/**
 * Operation catalog — the single source of MCP tool material.
 *
 * Built from the live OpenAPI spec (`buildOpenApiSpec()`, the same assembly
 * that backs `GET /api/openapi.json`), so every documented endpoint —
 * core and module-contributed — is automatically reachable as an MCP
 * operation with zero per-endpoint maintenance. `scripts/verify-openapi.ts`
 * enforces `code ⊆ spec`, so the catalog is a complete, trustworthy view of
 * what the API can do.
 *
 * Built lazily on first use (long after boot, so all modules have
 * contributed their paths) and cached for the process lifetime.
 *
 * What an operation requires of its caller is read off the guards mounted on
 * its route ({@link operationRequirement}), so the index and the tool surface
 * derive from the same table that enforces them — never a second list.
 */

import { buildOpenApiSpec } from "../../openapi/index.ts";
import { getPlatformRoutes } from "../../lib/platform-app.ts";
import {
  deriveRouteRequirements,
  isGranted,
  routeRequirementKey,
  type RouteRequirement,
  type RouteTable,
} from "../../lib/route-requirements.ts";
import {
  getModuleOpenApiPaths,
  getModuleOpenApiComponentSchemas,
  getModuleOpenApiTags,
} from "../../lib/modules/module-loader.ts";

/** HTTP methods that can carry an operation. */
const OPERATION_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type OperationMethod = (typeof OPERATION_METHODS)[number];

/** Minimal shape of an OpenAPI operation node we depend on. */
interface OperationNode {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown;
  requestBody?: unknown;
  responses?: unknown;
}

export interface CatalogOperation {
  operationId: string;
  /** Upper-case HTTP method. */
  method: string;
  /** Path template, e.g. `/api/agents/{scope}/{name}`. */
  pathTemplate: string;
  tags: string[];
  summary: string;
  description: string;
  /** Names of `{param}` placeholders in the path template. */
  pathParams: string[];
  /** Names of OpenAPI `in: header` parameters this operation declares. */
  headerParams: string[];
  /** Raw OpenAPI operation node (for `describe_operation`). */
  operation: OperationNode;
}

interface OperationCatalog {
  operations: Map<string, CatalogOperation>;
  /** Component schemas, for resolving `$ref`s in `describe_operation`. */
  componentSchemas: Record<string, unknown>;
}

let cached: OperationCatalog | null = null;

/**
 * Permission-scoped operation indexes, memoised per permission SET. The MCP
 * router builds one on every `tools/call` POST (server `instructions` are
 * assembled per request), and the chat module drives every tool call through
 * that router — so without this each tool call re-sorted and re-joined ~230
 * operations. Keyed by the sorted permission list (order-independent), bounded
 * with insertion-order eviction: distinct permission sets are one per role
 * plus one per custom API-key scope combination, a small population.
 *
 * Cleared whenever the catalog is (re)built so a rebuilt catalog can never
 * serve an index derived from the previous one.
 */
const indexByPermissions = new Map<string, string>();
const MAX_SCOPED_INDEXES = 64;
let scopedIndexBuilds = 0;

/**
 * The mounted routes, queryable per operation — see {@link operationRequirement}.
 * A separate memo rather than a catalog field, and derived on the first call
 * (in production a request, hence after `registerModuleRoutes` finished): the
 * app registers itself with `setPlatformApp` BEFORE the module routers mount,
 * so deriving at boot would freeze a partial table. Dropped with the rest, so
 * a rebuilt catalog is never joined against a stale table.
 */
let routeTable: RouteTable | null = null;

function permissionsKey(permissions: ReadonlySet<string>): string {
  return [...permissions].sort().join(",");
}

/**
 * Observability for the scoped-index memo: how many entries it holds and how
 * many times a scoped index was actually built (a miss). Read by the catalog
 * tests to prove a repeated permission set is served from the map — string
 * identity cannot show that (`Object.is` compares strings by value).
 */
export function getOperationIndexCacheStats(): { entries: number; builds: number } {
  return { entries: indexByPermissions.size, builds: scopedIndexBuilds };
}

function resetDerivedCaches(): void {
  indexByPermissions.clear();
  scopedIndexBuilds = 0;
  routeTable = null;
}

const PATH_PARAM_RE = /\{([^}]+)\}/g;

function extractPathParams(pathTemplate: string): string[] {
  const names: string[] = [];
  for (const match of pathTemplate.matchAll(PATH_PARAM_RE)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

function isOperationNode(value: unknown): value is OperationNode {
  return typeof value === "object" && value !== null;
}

/**
 * Names of `in: header` parameters declared by an operation. Lets
 * invoke_operation route a value the model supplied (in any bag) to a real
 * request header — required by e.g. the Credential Proxy family, which keys
 * off `X-Integration-Id`. Auth-context headers are never sourced from here.
 */
function extractHeaderParams(node: OperationNode): string[] {
  const params = node.parameters;
  if (!Array.isArray(params)) return [];
  const names: string[] = [];
  for (const p of params) {
    if (typeof p === "object" && p !== null) {
      const param = p as { in?: unknown; name?: unknown };
      if (param.in === "header" && typeof param.name === "string") names.push(param.name);
    }
  }
  return names;
}

/**
 * The MCP server's own endpoints, excluded from the operation catalog so it
 * never offers them as invokable operations (no recursive self-invocation, no
 * exposing the JSON-RPC envelope as a "tool"). Covers the per-org transport
 * endpoints (`/api/mcp/o/:org`) and the RFC 9728 discovery well-known.
 */
function isExcludedPath(pathTemplate: string): boolean {
  return (
    pathTemplate.startsWith("/api/mcp/o") ||
    pathTemplate.startsWith("/.well-known/oauth-protected-resource") ||
    // The catalog's own source and its human viewer, not operations a caller
    // acts with — `describe_operation` already serves the spec piecewise.
    pathTemplate === "/api/openapi.json" ||
    pathTemplate === "/api/docs"
  );
}

/** Build (or return cached) the operation catalog from the live OpenAPI spec. */
export function getCatalog(): OperationCatalog {
  if (cached) return cached;

  const spec = buildOpenApiSpec(
    getModuleOpenApiPaths(),
    getModuleOpenApiComponentSchemas(),
    getModuleOpenApiTags(),
  );

  const paths = spec.paths as Record<string, Record<string, unknown>>;
  const componentSchemas = (spec.components?.schemas ?? {}) as Record<string, unknown>;

  const operations = new Map<string, CatalogOperation>();
  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    // Exclude the MCP server's own transport + discovery endpoints so the
    // catalog never offers them as invokable operations (no recursive
    // self-invocation, no exposing the JSON-RPC envelope as a "tool").
    if (isExcludedPath(pathTemplate)) continue;
    for (const method of OPERATION_METHODS) {
      const node = (pathItem as Record<OperationMethod, unknown>)[method];
      if (!isOperationNode(node) || typeof node.operationId !== "string") continue;
      operations.set(node.operationId, {
        operationId: node.operationId,
        method: method.toUpperCase(),
        pathTemplate,
        tags: Array.isArray(node.tags) ? node.tags.filter((t) => typeof t === "string") : [],
        summary: typeof node.summary === "string" ? node.summary : "",
        description: typeof node.description === "string" ? node.description : "",
        pathParams: extractPathParams(pathTemplate),
        headerParams: extractHeaderParams(node),
        operation: node,
      });
    }
  }

  cached = { operations, componentSchemas };
  // A (re)built catalog invalidates every index derived from the previous
  // one — `resetCatalog` alone is not enough, since it is the assignment
  // above that changes what an index would be built from.
  resetDerivedCaches();
  return cached;
}

/** Reset the cached catalog and everything derived from it. Tests only. */
export function resetCatalog(): void {
  cached = null;
  resetDerivedCaches();
}

/**
 * What the route behind this operation requires of the caller's permission set.
 *
 * Read off `getPlatformRoutes()`, where the guards actually sit. There is
 * deliberately no fallback to "unfiltered", and an operation no route serves
 * throws rather than answering `NO_REQUIREMENT`: either would turn a mismatch
 * into a grant. That mismatch is what `scripts/verify-openapi.ts` catches.
 */
export function operationRequirement(op: CatalogOperation): RouteRequirement {
  routeTable ??= deriveRouteRequirements(getPlatformRoutes());
  const requirement = routeTable.requirementFor(op.method, op.pathTemplate);
  if (!requirement) {
    const key = routeRequirementKey(op.method, op.pathTemplate);
    throw new Error(
      `Operation ${op.operationId} has no mounted route for \`${key}\` — the OpenAPI document and the route table disagree`,
    );
  }
  return requirement;
}

/** Whether `permissions` clears every guard mounted on this operation's route. */
export function operationGranted(op: CatalogOperation, permissions: ReadonlySet<string>): boolean {
  return isGranted(operationRequirement(op), permissions);
}

/**
 * A compact, generated index of the operations this caller may invoke, grouped
 * by tag — one comma-separated line of operationIds per tag:
 *
 *   ## Agents
 *   listAgents, runAgent
 *
 * Method/path are deliberately omitted (they come from describe_operation or
 * search_operations' best_match); this is a discovery aid that lets a client
 * pick an operationId directly, skipping a search_operations round-trip. It is
 * fully derived from the live catalog and memoized, so it grows with the API
 * surface without any hand maintenance.
 *
 * Filtered PER OPERATION against the guards mounted on its route
 * ({@link operationGranted}), so a tag whose operations are all denied has no
 * section at all. That is context reduction and honesty — never a security
 * boundary: invoke_operation dispatches through the real route, which
 * re-enforces RBAC on every call, and a row-conditional operation stays listed
 * because only the loaded row can refuse it.
 */
export function buildOperationIndex(permissions: ReadonlySet<string>): string {
  const key = permissionsKey(permissions);
  const hit = indexByPermissions.get(key);
  if (hit !== undefined) return hit;

  // `getCatalog()` may rebuild (and thereby clear the index map) — call it
  // BEFORE the memo write below so the entry is stored against the catalog it
  // was derived from.
  const { operations } = getCatalog();
  const byTag = new Map<string, string[]>();
  for (const op of operations.values()) {
    if (!operationGranted(op, permissions)) continue;
    const tag = op.tags[0] ?? "Other";
    // operationId ONLY — the per-op summary is dropped from the index to keep it
    // compact (it's several KB across ~230 ops, re-sent every uncached turn).
    // describe_operation remains the source of truth for what each op does + its
    // schema, so the model gets the full detail when it picks an id from here.
    (byTag.get(tag) ?? byTag.set(tag, []).get(tag)!).push(op.operationId);
  }

  const sections = [...byTag.keys()].sort().map((tag) => {
    // One compact, comma-separated line of operationIds per tag.
    const ids = byTag.get(tag)!.sort();
    return `## ${tag}\n${ids.join(", ")}`;
  });

  const result = sections.join("\n\n");
  scopedIndexBuilds += 1;
  if (indexByPermissions.size >= MAX_SCOPED_INDEXES) {
    const oldest = indexByPermissions.keys().next().value;
    if (oldest !== undefined) indexByPermissions.delete(oldest);
  }
  indexByPermissions.set(key, result);
  return result;
}

const SCHEMA_REF_PREFIX = "#/components/schemas/";

/**
 * Collect every component schema reachable from a node via `$ref`, returning
 * a `{ name: schema }` map. Lets `describe_operation` ship the referenced
 * schemas inline so the model sees concrete shapes without a second lookup.
 */
export function collectReferencedSchemas(
  root: unknown,
  componentSchemas: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  const queue: unknown[] = [root];

  while (queue.length > 0) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith(SCHEMA_REF_PREFIX)) {
        const name = value.slice(SCHEMA_REF_PREFIX.length);
        if (!(name in resolved) && name in componentSchemas) {
          resolved[name] = componentSchemas[name];
          queue.push(componentSchemas[name]);
        }
        continue;
      }
      queue.push(value);
    }
  }

  return resolved;
}
