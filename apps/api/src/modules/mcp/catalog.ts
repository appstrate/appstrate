// SPDX-License-Identifier: Apache-2.0

/**
 * Operation catalog — the single source of MCP tool material, derived from the
 * operations the platform app registered (`lib/platform-app.ts`): the live
 * OpenAPI spec (which also backs `GET /api/openapi.json`) joined onto what the
 * guards mounted on each route ask of the caller. The index and the tool
 * surface thus derive from the table that enforces them — never a second list.
 */

import { getPlatformOperations, type PlatformOperations } from "../../lib/platform-app.ts";
import { isGranted, type RouteRequirement } from "../../lib/route-requirements.ts";

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

/** Keyed on the registration, so registering another app re-derives it. */
const catalogs = new WeakMap<PlatformOperations, OperationCatalog>();

const PATH_PARAM_RE = /\{([^}]+)\}/g;

function extractPathParams(pathTemplate: string): string[] {
  const names: string[] = [];
  for (const match of pathTemplate.matchAll(PATH_PARAM_RE)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
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
  const source = getPlatformOperations();
  let catalog = catalogs.get(source);
  if (!catalog) {
    catalog = buildCatalog(source);
    catalogs.set(source, catalog);
  }
  return catalog;
}

function buildCatalog(source: PlatformOperations): OperationCatalog {
  const operations = new Map<string, CatalogOperation>();
  for (const { operationId, method, pathTemplate, node, requirement } of source.operations) {
    if (isExcludedPath(pathTemplate)) continue;
    const operation = node as OperationNode;
    operations.set(operationId, {
      operationId,
      method,
      pathTemplate,
      tags: Array.isArray(operation.tags)
        ? operation.tags.filter((t) => typeof t === "string")
        : [],
      summary: typeof operation.summary === "string" ? operation.summary : "",
      description: typeof operation.description === "string" ? operation.description : "",
      pathParams: extractPathParams(pathTemplate),
      headerParams: extractHeaderParams(operation),
      requirement,
      operation,
    });
  }
  const componentSchemas = (source.spec.components?.schemas ?? {}) as Record<string, unknown>;
  return { operations, componentSchemas };
}

export function operationGranted(op: CatalogOperation, permissions: ReadonlySet<string>): boolean {
  return isGranted(op.requirement, permissions);
}

/**
 * {@link operationGranted} for an operation the code names. An unknown id is a
 * rename this code did not follow — a programming error, never a denial.
 */
export function operationIdGranted(operationId: string, permissions: ReadonlySet<string>): boolean {
  const op = getCatalog().operations.get(operationId);
  if (!op) throw new Error(`Catalog has no \`${operationId}\` operation`);
  return operationGranted(op, permissions);
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
