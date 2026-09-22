// SPDX-License-Identifier: Apache-2.0

/**
 * Operation catalog — the MCP tool material: the operations `registerPlatformApp`
 * joined onto their routes' guards, so the index and tools read the enforcing table.
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
 * Kept out of the catalog: the MCP transport and its RFC 9728 well-known (no
 * recursive self-invocation), and the spec document and its viewer, which
 * `describe_operation` already serves piecewise.
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
 * The operations this caller may invoke, one line of operationIds per tag. The
 * filter is context reduction, not a security boundary: the dispatched route
 * re-enforces RBAC on every call.
 */
export function buildOperationIndex(permissions: ReadonlySet<string>): string {
  const { operations } = getCatalog();
  const byTag = new Map<string, string[]>();
  for (const op of operations.values()) {
    if (!operationGranted(op, permissions)) continue;
    const tag = op.tags[0] ?? "Other";
    // operationId only: summaries would cost several KB on every uncached turn.
    (byTag.get(tag) ?? byTag.set(tag, []).get(tag)!).push(op.operationId);
  }

  const sections = [...byTag.keys()].sort().map((tag) => {
    const ids = byTag.get(tag)!.sort();
    return `## ${tag}\n${ids.join(", ")}`;
  });

  return sections.join("\n\n");
}

const SCHEMA_REF_PREFIX = "#/components/schemas/";

/** Every component schema reachable from `root` via `$ref`, for describe_operation to inline. */
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
