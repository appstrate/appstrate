// SPDX-License-Identifier: Apache-2.0

/**
 * The fully-wired root Hono app and the documented operations it serves.
 *
 * In-process self-dispatch sends a request back through the full platform
 * middleware chain via `app.fetch(request)` — no socket, no second auth
 * implementation — so callers reuse the exact authorization surface of the
 * REST API.
 */

import type { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { buildOpenApiSpec } from "../openapi/index.ts";
import { deriveRouteRequirements, type RouteRequirement } from "./route-requirements.ts";
import {
  getModuleOpenApiPaths,
  getModuleOpenApiComponentSchemas,
  getModuleOpenApiTags,
} from "./modules/module-loader.ts";

const OPERATION_METHODS = ["get", "post", "put", "patch", "delete"] as const;

type OpenApiSpec = ReturnType<typeof buildOpenApiSpec>;

interface PlatformOperation {
  readonly operationId: string;
  /** Upper-case HTTP method. */
  readonly method: string;
  readonly pathTemplate: string;
  readonly node: Record<string, unknown>;
  readonly requirement: RouteRequirement;
}

/** Fresh per registration, so a derivation can be cached on its identity. */
export interface PlatformOperations {
  readonly spec: OpenApiSpec;
  readonly operations: readonly PlatformOperation[];
}

let registered: { app: Hono<AppEnv>; operations: PlatformOperations } | null = null;

/**
 * Call once every module is loaded and every route mounted: joins each OpenAPI
 * operation onto its route's guards. Throws — keeping any previous registration
 * — when a documented operation has no route, so the mismatch fails the boot.
 */
export function registerPlatformApp(app: Hono<AppEnv>): void {
  const spec = buildOpenApiSpec(
    getModuleOpenApiPaths(),
    getModuleOpenApiComponentSchemas(),
    getModuleOpenApiTags(),
  );
  const requirementFor = deriveRouteRequirements(app.routes);
  const operations: PlatformOperation[] = [];
  const orphans: string[] = [];
  for (const [pathTemplate, pathItem] of Object.entries(spec.paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const method of OPERATION_METHODS) {
      const node = (pathItem as Record<string, unknown>)[method];
      if (typeof node !== "object" || node === null) continue;
      const operationId = (node as { operationId?: unknown }).operationId;
      if (typeof operationId !== "string") continue;
      const httpMethod = method.toUpperCase();
      // No fallback to "unguarded": an operation the route table cannot find
      // would be published as needing nothing, turning a mismatch into a grant.
      const requirement = requirementFor(httpMethod, pathTemplate);
      if (!requirement) {
        orphans.push(`${operationId} (${httpMethod} ${pathTemplate})`);
        continue;
      }
      operations.push({
        operationId,
        method: httpMethod,
        pathTemplate,
        node: node as Record<string, unknown>,
        requirement,
      });
    }
  }
  if (orphans.length > 0) {
    throw new Error(
      `The OpenAPI document and the route table disagree — no mounted route serves: ${orphans.join(", ")}`,
    );
  }
  registered = { app, operations: Object.freeze({ spec, operations: Object.freeze(operations) }) };
}

/** Throws before `registerPlatformApp()` — a programming error. */
function getRegistered(use: string): { app: Hono<AppEnv>; operations: PlatformOperations } {
  if (!registered) {
    throw new Error(`Platform app not registered — registerPlatformApp() must run before ${use}`);
  }
  return registered;
}

/**
 * Re-enter the fully-wired platform app in-process (no socket hop). `app.fetch`
 * returns `Response | Promise<Response>`; the async wrapper normalizes it to the
 * `Promise<Response>` callers (the `inProcess` service, the MCP router) expect.
 */
export function dispatchInProcess(request: Request): Promise<Response> {
  return Promise.resolve(getRegistered("in-process dispatch").app.fetch(request));
}

export function getPlatformOperations(): PlatformOperations {
  return getRegistered("reading the platform operations").operations;
}
