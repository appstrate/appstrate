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
 *   2. the OpenAPI declaration — the `Idempotency-Key` header parameter,
 *      written by hand on each supported operation.
 *
 * This test fails when (2) stops matching the mounts, in either direction:
 * mounting `idempotency()` on a new route without declaring the parameter, or
 * declaring it on an operation that does not honour it.
 *
 * (2) is matched by parameter **name**, not by `$ref` target. An earlier
 * version only recognised `$ref: "#/components/parameters/IdempotencyKey"`,
 * which made every *inline* `{ name: "Idempotency-Key", in: "header" }`
 * invisible — and `openapi/paths/llm-proxy.ts` declared exactly that on three
 * operations that have never mounted `idempotency()`. A drift guard blind to
 * half the ways the contract can be written is not a drift guard.
 */

import { describe, it, expect } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { getDiscoveredModules } from "../../helpers/test-modules.ts";
import { buildOpenApiSpec } from "../../../src/openapi/index.ts";
import { isIdempotencyAware } from "../../../src/middleware/idempotency.ts";
import type { Hono } from "hono";
import type { AppEnv } from "../../../src/types/index.ts";

/** RFC 9110 §5.1 makes field names case-insensitive — compare lowercased. */
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

const COMPONENT_PARAMETER_REF = "#/components/parameters/";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

type OpenApiSpec = {
  paths: Record<string, unknown>;
  components?: { parameters?: Record<string, unknown> };
};

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

/**
 * True when `param` is the `Idempotency-Key` header parameter, written either
 * inline or as a `$ref` into `components.parameters` (resolved one hop — the
 * only form OpenAPI 3.1 allows for a parameter component).
 */
function isIdempotencyKeyParam(param: unknown, spec: OpenApiSpec): boolean {
  if (typeof param !== "object" || param === null) return false;
  const ref = (param as { $ref?: unknown }).$ref;
  if (typeof ref === "string") {
    if (!ref.startsWith(COMPONENT_PARAMETER_REF)) return false;
    const target = spec.components?.parameters?.[ref.slice(COMPONENT_PARAMETER_REF.length)];
    return target === undefined ? false : isIdempotencyKeyParam(target, spec);
  }
  const { name, in: location } = param as { name?: unknown; in?: unknown };
  return (
    location === "header" &&
    typeof name === "string" &&
    name.toLowerCase() === IDEMPOTENCY_KEY_HEADER
  );
}

/**
 * Operations whose OpenAPI definition declares the `Idempotency-Key`
 * parameter — on the operation itself or on its path item, which OpenAPI 3.1
 * §4.8.9 applies to every operation under that path.
 */
function declaredOperations(spec: OpenApiSpec): Set<string> {
  const found = new Set<string>();
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    const item = pathItem as { parameters?: unknown } & Record<string, unknown>;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      const own = (operation as { parameters?: unknown }).parameters;
      const params = [...shared, ...(Array.isArray(own) ? own : [])];
      if (params.some((p) => isIdempotencyKeyParam(p, spec))) found.add(`${method} ${path}`);
    }
  }
  return found;
}

function buildSpecFor(modules: readonly { openApiPaths?: () => object }[]): OpenApiSpec {
  const paths = Object.assign({}, ...modules.map((m) => m.openApiPaths?.() ?? {}));
  return buildOpenApiSpec(paths) as unknown as OpenApiSpec;
}

describe("Idempotency-Key contract (drift guard)", () => {
  it("declares the parameter on exactly the operations that mount idempotency()", () => {
    // Covers every module the test preload discovers — built-ins under
    // `apps/api/src/modules/*` plus the workspace `packages/module-*`. It does
    // NOT reach an operator-installed out-of-tree module: those are absent
    // from this process entirely. That is not a coverage hole today, because
    // no out-of-tree module *can* mount `idempotency()` — the middleware is
    // exported from no package (see `middleware/idempotency-guard.ts` and
    // `src/modules/README.md` → "Idempotency"). If that ever changes, this
    // assertion stops being the whole story and the export needs its own
    // drift check.
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

  describe("detects the declaration however it is written", () => {
    // `declaredOperations` is the half of the drift guard that reads the spec.
    // If it only recognises one spelling of the parameter, a false promise
    // written the other way passes CI — which is exactly what happened to
    // `openapi/paths/llm-proxy.ts` (inline declaration, no mount, invisible).
    function specWith(parameters: unknown[], pathItemParameters?: unknown[]): OpenApiSpec {
      return {
        paths: {
          "/api/fake": {
            ...(pathItemParameters ? { parameters: pathItemParameters } : {}),
            post: { parameters },
          },
        },
        components: {
          parameters: {
            IdempotencyKey: { name: "Idempotency-Key", in: "header" },
            SomethingElse: { name: "X-Run-Id", in: "header" },
          },
        },
      };
    }

    it("catches an inline declaration", () => {
      const spec = specWith([
        { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } },
      ]);
      expect([...declaredOperations(spec)]).toEqual(["post /api/fake"]);
    });

    it("catches a $ref declaration", () => {
      const spec = specWith([{ $ref: "#/components/parameters/IdempotencyKey" }]);
      expect([...declaredOperations(spec)]).toEqual(["post /api/fake"]);
    });

    it("catches a declaration inherited from the path item", () => {
      // OpenAPI 3.1 §4.8.9: path-item parameters apply to every operation.
      const spec = specWith([], [{ name: "Idempotency-Key", in: "header" }]);
      expect([...declaredOperations(spec)]).toEqual(["post /api/fake"]);
    });

    it("matches the header name case-insensitively (RFC 9110 §5.1)", () => {
      const spec = specWith([{ name: "idempotency-key", in: "header" }]);
      expect([...declaredOperations(spec)]).toEqual(["post /api/fake"]);
    });

    it("does not fire on another header, or on a same-named query parameter", () => {
      expect([
        ...declaredOperations(specWith([{ $ref: "#/components/parameters/SomethingElse" }])),
      ]).toEqual([]);
      expect([...declaredOperations(specWith([{ name: "Idempotency-Key", in: "query" }]))]).toEqual(
        [],
      );
    });

    it("catches the exact llm-proxy regression: inline, mounted nowhere", () => {
      // The shape `openapi/paths/llm-proxy.ts` carried for three operations.
      // Feeding it through the real core spec must now make the drift guard's
      // main assertion fail, not pass.
      const inline = {
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description: "Optional idempotency key.",
        schema: { type: "string", maxLength: 256 },
      };
      const spec = buildSpecFor([
        { openApiPaths: () => ({ "/api/llm-proxy/fake": { post: { parameters: [inline] } } }) },
      ]);
      expect(declaredOperations(spec).has("post /api/llm-proxy/fake")).toBe(true);
      expect(mountedOperations(getTestApp()).has("post /api/llm-proxy/fake")).toBe(false);
    });
  });
});
