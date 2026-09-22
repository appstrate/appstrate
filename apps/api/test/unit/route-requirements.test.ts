// SPDX-License-Identifier: Apache-2.0

/**
 * Unit contract for `lib/route-requirements.ts`.
 *
 * The table answers the question Hono's matcher answers, not the question a
 * lookup keyed on exact paths would: `app.on(["POST"], "/api/auth/*")` serves
 * a dozen operations from one entry, `router.all("/proxy")` serves five
 * methods from one, and a prefix guard gates everything beneath it. An
 * operation the reader cannot find resolves to `undefined` — the caller, not
 * this table, turns that into a failure — so each of those shapes is pinned
 * here, against real guards on real Hono apps.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { PERMISSION_REQUIREMENT_MARKER } from "@appstrate/core/permissions";
import {
  NO_REQUIREMENT,
  deriveRouteRequirements,
  isGranted,
  routeRequirementKey,
  type RouteRequirement,
  type RouteTable,
} from "../../src/lib/route-requirements.ts";
import { readHandlerMarker } from "../../src/middleware/handler-marker.ts";
import { requirePackageInOrg } from "../../src/middleware/guards.ts";
import {
  requireAnyPermission,
  requirePermission,
} from "../../src/middleware/require-permission.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";
import type { AppEnv } from "../../src/types/index.ts";

const ok = () => new Response("ok");

/**
 * A root app with `sub` mounted under `/api`, the way every router in
 * `index.ts` is mounted. `sub` installs its own `onError()` on purpose: hono's
 * `route()` then re-wraps every handler it copies, which is the wrapping
 * `handler-marker.ts` unwraps through. A flat app would never exercise it.
 */
function mounted(
  build: (sub: Hono<AppEnv>) => void,
  buildRoot?: (app: Hono<AppEnv>) => void,
): Hono<AppEnv> {
  const sub = new Hono<AppEnv>();
  sub.onError(errorHandler);
  build(sub);
  const app = new Hono<AppEnv>();
  buildRoot?.(app);
  app.route("/api", sub);
  return app;
}

function tableOf(
  build: (sub: Hono<AppEnv>) => void,
  buildRoot?: (app: Hono<AppEnv>) => void,
): RouteTable {
  return deriveRouteRequirements(mounted(build, buildRoot).routes);
}

/** For the mounts that only exist at the root: `app.on([...], "/x/*")`, `app.use`. */
function rootTableOf(build: (app: Hono<AppEnv>) => void): RouteTable {
  const app = new Hono<AppEnv>();
  build(app);
  return deriveRouteRequirements(app.routes);
}

/** The requirement for `METHOD template`, or a failure naming it. */
function served(table: RouteTable, method: string, template: string): RouteRequirement {
  const derived = table.requirementFor(method, template);
  if (!derived) throw new Error(`no route serves \`${method} ${template}\``);
  return derived;
}

describe("routeRequirementKey", () => {
  it("rewrites hono's `:param` into the catalog's `{param}`", () => {
    expect(routeRequirementKey("POST", "/api/agents/:scope/:name/run")).toBe(
      "POST /api/agents/{scope}/{name}/run",
    );
  });

  it("drops a param's inline regex constraint", () => {
    expect(routeRequirementKey("GET", "/api/things/:id{[0-9]+}")).toBe("GET /api/things/{id}");
  });

  it("drops a constraint that itself contains a slash", () => {
    // `routes/integrations.ts` really mounts this: a package id is
    // `@scope/name`, so its constraint spans a path separator.
    expect(
      routeRequirementKey("PATCH", "/api/integrations/:packageId{@[^/]+/[^/]+}/settings"),
    ).toBe("PATCH /api/integrations/{packageId}/settings");
  });
});

describe("requirementFor — exact mounts", () => {
  it("matches on the MERGED path, in the catalog's param spelling", () => {
    const requirement = served(
      tableOf((sub) =>
        sub.post("/agents/:scope/:name/run", requirePermission("agents", "run"), ok),
      ),
      "POST",
      "/api/agents/{scope}/{name}/run",
    );
    expect(requirement.requirements).toEqual(["agents:run"]);
    expect(requirement.conditional).toBe(false);
  });

  it("records two guards on one route as two entries, in mount order", () => {
    const requirement = served(
      tableOf((sub) =>
        sub.post(
          "/runs/inline",
          requirePermission("agents", "write"),
          requirePermission("agents", "run"),
          ok,
        ),
      ),
      "POST",
      "/api/runs/inline",
    );
    expect(requirement.requirements).toEqual(["agents:write", "agents:run"]);
  });

  it("keeps a disjunction as ONE entry", () => {
    // Two entries would mean "both", the opposite of what the guard enforces.
    const requirement = served(
      tableOf((sub) => sub.get("/runs", requireAnyPermission(["runs:read", "runs:read-all"]), ok)),
      "GET",
      "/api/runs",
    );
    expect(requirement.requirements).toEqual(["runs:read|runs:read-all"]);
    expect(requirement.conditional).toBe(false);
  });

  it("reads a row-aware guard as conditional, naming no permission", () => {
    const requirement = served(
      tableOf((sub) => sub.delete("/packages/:scope/:name", requirePackageInOrg("delete"), ok)),
      "DELETE",
      "/api/packages/{scope}/{name}",
    );
    expect(requirement.requirements).toEqual([]);
    expect(requirement.conditional).toBe(true);
  });

  it("serves an unguarded route with no requirement, rather than not at all", () => {
    // "No guard" is an answer; `undefined` would read as "route went missing".
    const requirement = served(
      tableOf((sub) => sub.post("/welcome/setup", async (_c, next) => next(), ok)),
      "POST",
      "/api/welcome/setup",
    );
    expect(requirement.requirements).toEqual([]);
    expect(requirement.conditional).toBe(false);
  });

  it("serves every method from one `router.all`, carrying its guard", () => {
    const table = tableOf((sub) =>
      sub.all("/credential-proxy/proxy", requirePermission("credential-proxy", "call"), ok),
    );
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(served(table, method, "/api/credential-proxy/proxy").requirements).toEqual([
        "credential-proxy:call",
      ]);
    }
  });
});

describe("requirementFor — prefix mounts", () => {
  it("serves everything under a wildcard mounted with a concrete method", () => {
    // The Better Auth family: one mount answers ~12 documented operations, and
    // "served, requires nothing" is not the same answer as "no such route".
    const requirement = served(
      rootTableOf((app) => app.on(["POST", "GET"], "/api/auth/*", ok)),
      "POST",
      "/api/auth/sign-in/email",
    );
    expect(requirement.requirements).toEqual(NO_REQUIREMENT.requirements);
    expect(requirement.conditional).toBe(NO_REQUIREMENT.conditional);
  });

  it("folds a prefix guard into the requirement of an exact route beneath it", () => {
    const requirement = served(
      rootTableOf((app) => {
        app.use("/api/*", requirePermission("agents", "read"));
        app.post("/api/kept", requirePermission("agents", "write"), ok);
      }),
      "POST",
      "/api/kept",
    );
    expect(requirement.requirements).toEqual(["agents:read", "agents:write"]);
  });

  it("folds a prefix guard onto the prefix's own template", () => {
    // Hono runs `app.use("/api/x/*")` for `/api/x` itself, so a guard mounted
    // that way gates the collection route too — `spaces.ts` mounts both forms
    // side by side precisely because the `/*` form alone used to miss it.
    const requirement = served(
      tableOf(
        (sub) => sub.get("/x", ok),
        (app) => app.use("/api/x/*", requirePermission("spaces", "read")),
      ),
      "GET",
      "/api/x",
    );
    expect(requirement.requirements).toEqual(["spaces:read"]);
  });

  it("names one guard once, however many entries reach it", () => {
    // The same instance mounted on a prefix AND on the route beneath is one
    // check at runtime; listing it twice would read as a stricter requirement.
    const guard = requirePermission("agents", "read");
    const requirement = served(
      rootTableOf((app) => {
        app.use("/api/*", guard);
        app.post("/api/kept", guard, ok);
      }),
      "POST",
      "/api/kept",
    );
    expect(requirement.requirements).toEqual(["agents:read"]);
  });

  it("does not serve a template covered only by `app.use` middleware", () => {
    // Treating `use` as a route would invent an operation for every spellable path.
    const table = rootTableOf((app) => app.use("/api/*", requirePermission("agents", "read")));
    expect(table.requirementFor("POST", "/api/anything")).toBeUndefined();
  });

  it("decorates but does not serve, for an `ALL /*` mount", () => {
    const table = tableOf((sub) => {
      sub.use("/*", requirePackageInOrg());
      sub.get("/kept", ok);
    });
    expect(served(table, "GET", "/api/kept").conditional).toBe(true);
    expect(table.requirementFor("GET", "/api/never-mounted")).toBeUndefined();
  });

  it("does not serve a template no entry covers", () => {
    const table = tableOf((sub) => sub.get("/kept", ok));
    expect(table.requirementFor("GET", "/api/elsewhere")).toBeUndefined();
    expect(table.requirementFor("DELETE", "/api/kept")).toBeUndefined();
  });
});

describe("requireAnyPermission", () => {
  it("refuses an empty alternative list at construction", () => {
    // `some()` over nothing is false, so the guard would deny every caller
    // while stamping an empty requirement the catalog reads as "public".
    expect(() => requireAnyPermission([])).toThrow();
  });
});

describe("readHandlerMarker", () => {
  const app = mounted((sub) => sub.post("/agents", requirePermission("agents", "write"), ok));
  const chain = app.routes.filter(
    (route) => route.method === "POST" && route.path === "/api/agents",
  );

  it("reads the requirement through hono's onError() re-wrapping", () => {
    expect(
      chain.map((route) => readHandlerMarker(route.handler, PERMISSION_REQUIREMENT_MARKER)),
    ).toContain("agents:write");
  });

  it("is reading through a real wrapper — a bare property read sees nothing", () => {
    // Fixture check: proves the mount above wraps, so the assertion before it
    // exercises `findTargetHandler` rather than an unwrapped handler.
    const guard = chain[0]!.handler as unknown as Record<symbol, unknown>;
    expect(guard[PERMISSION_REQUIREMENT_MARKER]).toBeUndefined();
  });

  it("returns undefined for a middleware that stamps nothing", () => {
    expect(
      readHandlerMarker(
        async (_c: unknown, next: () => unknown) => next(),
        PERMISSION_REQUIREMENT_MARKER,
      ),
    ).toBeUndefined();
  });
});

describe("isGranted", () => {
  const conjunction = served(
    tableOf((sub) =>
      sub.post(
        "/runs/inline",
        requirePermission("agents", "write"),
        requirePermission("agents", "run"),
        ok,
      ),
    ),
    "POST",
    "/api/runs/inline",
  );
  const disjunction = served(
    tableOf((sub) => sub.get("/runs", requireAnyPermission(["runs:read", "runs:read-all"]), ok)),
    "GET",
    "/api/runs",
  );
  const rowAware = served(
    tableOf((sub) => sub.delete("/packages/:scope/:name", requirePackageInOrg("delete"), ok)),
    "DELETE",
    "/api/packages/{scope}/{name}",
  );

  it("needs every entry — two guards mean both", () => {
    expect(isGranted(conjunction, new Set(["agents:write", "agents:run"]))).toBe(true);
    expect(isGranted(conjunction, new Set(["agents:write"]))).toBe(false);
    expect(isGranted(conjunction, new Set(["agents:run"]))).toBe(false);
  });

  it("needs any alternative within one entry", () => {
    expect(isGranted(disjunction, new Set(["runs:read"]))).toBe(true);
    expect(isGranted(disjunction, new Set(["runs:read-all"]))).toBe(true);
    expect(isGranted(disjunction, new Set(["runs:cancel"]))).toBe(false);
  });

  it("grants NO_REQUIREMENT to a caller holding nothing", () => {
    expect(isGranted(NO_REQUIREMENT, new Set())).toBe(true);
  });

  it("grants a row-aware-only requirement — the row refuses, not the catalog", () => {
    // Plan rule 2: a row-dependent act stays visible and is described as
    // conditional; hiding it hides the page that explains the refusal.
    expect(isGranted(rowAware, new Set())).toBe(true);
  });

  it("denies an empty permission set wherever a requirement exists", () => {
    expect(isGranted(conjunction, new Set())).toBe(false);
    expect(isGranted(disjunction, new Set())).toBe(false);
  });
});
