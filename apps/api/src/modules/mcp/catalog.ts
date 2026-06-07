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
 */

import { buildOpenApiSpec } from "../../openapi/index.ts";
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

export interface OperationCatalog {
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

/** The MCP server's own endpoints, excluded from the operation catalog. */
function isExcludedPath(pathTemplate: string): boolean {
  return (
    pathTemplate === "/api/mcp" || pathTemplate.startsWith("/.well-known/oauth-protected-resource")
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
  return cached;
}

/** Reset the cached catalog. Tests only. */
export function resetCatalog(): void {
  cached = null;
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
