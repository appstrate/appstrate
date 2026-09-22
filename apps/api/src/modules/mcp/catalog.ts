// SPDX-License-Identifier: Apache-2.0

/**
 * Operation catalog — the single source of MCP tool material, built from the
 * live OpenAPI spec (`buildOpenApiSpec()`, which also backs
 * `GET /api/openapi.json`). Each operation carries what the guards mounted on
 * its route ask of the caller, so the index and the tool surface derive from
 * the table that enforces them — never a second list. Built on first use,
 * never at boot: the module-contributed paths and the mounted route table are
 * complete only once a request arrives.
 */

import { buildOpenApiSpec } from "../../openapi/index.ts";
import { getPlatformRoutes } from "../../lib/platform-app.ts";
import {
  deriveRouteRequirements,
  isGranted,
  type RouteRequirement,
} from "../../lib/route-requirements.ts";
import {
  getModuleOpenApiPaths,
  getModuleOpenApiComponentSchemas,
  getModuleOpenApiTags,
} from "../../lib/modules/module-loader.ts";

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
  pathTemplate: string;
  tags: string[];
  summary: string;
  description: string;
  pathParams: string[];
  /** Names of OpenAPI `in: header` parameters this operation declares. */
  headerParams: string[];
  /** What the guards mounted on this operation's route ask of the caller. */
  requirement: RouteRequirement;
  /** Raw OpenAPI operation node (for `describe_operation`). */
  operation: OperationNode;
}

interface OperationCatalog {
  operations: Map<string, CatalogOperation>;
  /** Component schemas, for resolving `$ref`s in `describe_operation`. */
  componentSchemas: Record<string, unknown>;
}

let cached: OperationCatalog | null = null;

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
 * Names of `in: header` parameters declared by an operation, so
 * invoke_operation can route a model-supplied value to a real request header —
 * the Credential Proxy family keys off `X-Integration-Id`. Auth-context
 * headers are never sourced from here.
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
 * Paths kept out of the catalog: the MCP transport and its RFC 9728 discovery
 * well-known, which as "tools" would expose the JSON-RPC envelope and invite
 * recursive self-invocation, plus the catalog's own source and human viewer,
 * which `describe_operation` already serves piecewise.
 */
function isExcludedPath(pathTemplate: string): boolean {
  return (
    pathTemplate.startsWith("/api/mcp/o") ||
    pathTemplate.startsWith("/.well-known/oauth-protected-resource") ||
    pathTemplate === "/api/openapi.json" ||
    pathTemplate === "/api/docs"
  );
}

export function getCatalog(): OperationCatalog {
  if (cached) return cached;

  const spec = buildOpenApiSpec(
    getModuleOpenApiPaths(),
    getModuleOpenApiComponentSchemas(),
    getModuleOpenApiTags(),
  );

  const paths = spec.paths as Record<string, Record<string, unknown>>;
  const componentSchemas = (spec.components?.schemas ?? {}) as Record<string, unknown>;
  const requirementFor = deriveRouteRequirements(getPlatformRoutes());

  const operations = new Map<string, CatalogOperation>();
  const unresolved: string[] = [];
  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    if (isExcludedPath(pathTemplate)) continue;
    for (const method of OPERATION_METHODS) {
      const node = (pathItem as Record<OperationMethod, unknown>)[method];
      if (!isOperationNode(node) || typeof node.operationId !== "string") continue;
      const httpMethod = method.toUpperCase();
      // No fallback to "unfiltered": an operation the route table cannot find
      // would be published as needing nothing, turning a mismatch into a grant.
      const requirement = requirementFor(httpMethod, pathTemplate);
      if (!requirement) {
        unresolved.push(`${node.operationId} (${httpMethod} ${pathTemplate})`);
        continue;
      }
      operations.set(node.operationId, {
        operationId: node.operationId,
        method: httpMethod,
        pathTemplate,
        tags: Array.isArray(node.tags) ? node.tags.filter((t) => typeof t === "string") : [],
        summary: typeof node.summary === "string" ? node.summary : "",
        description: typeof node.description === "string" ? node.description : "",
        pathParams: extractPathParams(pathTemplate),
        headerParams: extractHeaderParams(node),
        requirement,
        operation: node,
      });
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `The OpenAPI document and the route table disagree — no mounted route serves: ${unresolved.join(", ")}`,
    );
  }

  cached = { operations, componentSchemas };
  return cached;
}

/** Drop the cached catalog so the next read rebuilds it. Tests only. */
export function resetCatalog(): void {
  cached = null;
}

export function operationGranted(op: CatalogOperation, permissions: ReadonlySet<string>): boolean {
  return isGranted(op.requirement, permissions);
}

/**
 * A compact index of the operations this caller may invoke, grouped by tag —
 * one comma-separated line of operationIds per tag, so a client picks an id
 * straight from it instead of searching. Method/path are omitted;
 * describe_operation and search_operations' `best_match` carry them.
 *
 * Filtered PER OPERATION ({@link operationGranted}): context reduction, never
 * a security boundary — invoke_operation dispatches through the real route,
 * which re-enforces RBAC on every call, and a row-conditional operation stays
 * listed because only the loaded row can refuse it.
 */
export function buildOperationIndex(permissions: ReadonlySet<string>): string {
  const { operations } = getCatalog();
  const byTag = new Map<string, string[]>();
  for (const op of operations.values()) {
    if (!operationGranted(op, permissions)) continue;
    const tag = op.tags[0] ?? "Other";
    // operationId ONLY: the per-op summary costs several KB across the surface
    // and describe_operation stays the source of truth for what each one does.
    (byTag.get(tag) ?? byTag.set(tag, []).get(tag)!).push(op.operationId);
  }

  const sections = [...byTag.keys()].sort().map((tag) => {
    const ids = byTag.get(tag)!.sort();
    return `## ${tag}\n${ids.join(", ")}`;
  });

  return sections.join("\n\n");
}

const SCHEMA_REF_PREFIX = "#/components/schemas/";

/** Every component schema reachable from a node via `$ref`, as `{ name: schema }`
 *  — `describe_operation` inlines them so the model needs no second lookup. */
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
