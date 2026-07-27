// SPDX-License-Identifier: Apache-2.0

/**
 * `Idempotency-Key` drift guard.
 *
 * The supported set has exactly one source of truth: the routes where
 * `idempotency()` is mounted. Two things mirror it, and both can rot silently:
 *
 *   1. the runtime rejection (`idempotencyGuard`) — cannot drift by
 *      construction, it reads the mounts through Hono's match result, but this
 *      file proves the marker survives so the guard has something to read;
 *   2. the OpenAPI declaration — `$ref: IdempotencyKey` written by hand on
 *      each supported operation.
 *
 * This test fails when (2) stops matching the mounts, in either direction:
 * mounting `idempotency()` on a seventh route without declaring the parameter,
 * or declaring it on an operation that does not honour it.
 */

import { describe, it, expect } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { getDiscoveredModules } from "../../helpers/test-modules.ts";
import { buildOpenApiSpec } from "../../../src/openapi/index.ts";
import { isIdempotencyAware } from "../../../src/middleware/idempotency.ts";
import type { Hono } from "hono";
import type { AppEnv } from "../../../src/types/index.ts";

const IDEMPOTENCY_KEY_REF = "#/components/parameters/IdempotencyKey";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

/**
 * Hono route path → OpenAPI path template.
 * `/api/agents/:scope{(?:@|%40)…}/:name{…}/run` → `/api/agents/{scope}/{name}/run`
 */
function honoPathToOpenApi(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)(\{(?:[^{}]|\{[^{}]*\})*\})?/g, "{$1}");
}

/** Operations that actually mount `idempotency()`, as `"post /api/…"` keys. */
function mountedOperations(app: Hono<AppEnv>): Set<string> {
  return new Set(
    app.routes
      .filter((route) => isIdempotencyAware(route.handler))
      .map((route) => `${route.method.toLowerCase()} ${honoPathToOpenApi(route.path)}`),
  );
}

/** Operations whose OpenAPI definition declares the `Idempotency-Key` parameter. */
function declaredOperations(spec: { paths: Record<string, unknown> }): Set<string> {
  const found = new Set<string>();
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.includes(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      const params = (operation as { parameters?: unknown }).parameters;
      if (!Array.isArray(params)) continue;
      const declares = params.some(
        (p) =>
          typeof p === "object" &&
          p !== null &&
          (p as { $ref?: string }).$ref === IDEMPOTENCY_KEY_REF,
      );
      if (declares) found.add(`${method} ${path}`);
    }
  }
  return found;
}

function buildSpecFor(modules: readonly { openApiPaths?: () => object }[]) {
  const paths = Object.assign({}, ...modules.map((m) => m.openApiPaths?.() ?? {}));
  return buildOpenApiSpec(paths) as unknown as { paths: Record<string, unknown> };
}

describe("Idempotency-Key contract (drift guard)", () => {
  it("declares the parameter on exactly the operations that mount idempotency()", () => {
    // Module-agnostic on purpose: whatever module set is loaded, the mounts and
    // the spec must agree. A module that adds an idempotent route must declare
    // the parameter in its own `openApiPaths()`.
    const modules = getDiscoveredModules();
    const mounted = mountedOperations(getTestApp());
    const declared = declaredOperations(buildSpecFor(modules));

    expect([...declared].sort()).toEqual([...mounted].sort());
  });

  it("pins the core supported set", () => {
    // Core-only app (zero-footprint invariant): widening this list is a
    // deliberate API-contract decision, not something that happens by accident.
    const app = getTestApp({ modules: [] });
    expect([...mountedOperations(app)].sort()).toEqual([
      "post /api/agents/{scope}/{name}/run",
      "post /api/end-users",
      "post /api/runs/inline",
      "post /api/runs/remote",
    ]);
    expect([...declaredOperations(buildSpecFor([]))].sort()).toEqual([
      "post /api/agents/{scope}/{name}/run",
      "post /api/end-users",
      "post /api/runs/inline",
      "post /api/runs/remote",
    ]);
  });

  it("keeps the mount marker readable — the guard has something to detect", () => {
    // If `idempotency()` ever stops stamping its marker, `mountedOperations`
    // silently returns an empty set and every assertion above would still pass
    // against an empty spec. Assert non-emptiness explicitly.
    expect(mountedOperations(getTestApp()).size).toBeGreaterThan(0);
  });
});
