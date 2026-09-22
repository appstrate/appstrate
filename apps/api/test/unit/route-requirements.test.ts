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
import { Hono, type Context, type Next } from "hono";
import { PERMISSION_REQUIREMENT_MARKER } from "@appstrate/core/permissions";
import {
  deriveRouteRequirements,
  isGranted,
  markFallback,
  type RouteRequirement,
  type RouteRequirementLookup,
} from "../../src/lib/route-requirements.ts";
import { markHandler, readHandlerMarker } from "../../src/middleware/handler-marker.ts";
import { requirePackageInOrg } from "../../src/middleware/guards.ts";
import {
  isRowAuthority,
  markSpaceRescope,
  PERMISSION_GUARD,
  requireAnyPermission,
  requirePermission,
  rowAuthority,
} from "../../src/middleware/require-permission.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";
import type { AppEnv } from "../../src/types/index.ts";

const ok = () => new Response("ok");

/** A catch-all fallback, fresh each call: the marker is stamped on the function itself. */
const fallback = () => markFallback(() => new Response("fallback"));

/** A space re-scope, mounted the way `routes/spaces.ts` mounts one. */
const rescope = () => markSpaceRescope(async (_c: Context<AppEnv>, next: Next) => next());

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
): RouteRequirementLookup {
  return deriveRouteRequirements(mounted(build, buildRoot).routes);
}

/** For the mounts that only exist at the root: `app.on([...], "/x/*")`, `app.use`. */
function rootTableOf(build: (app: Hono<AppEnv>) => void): RouteRequirementLookup {
  const app = new Hono<AppEnv>();
  build(app);
  return deriveRouteRequirements(app.routes);
}

/** The requirement for `METHOD template`, or a failure naming it. */
function served(table: RouteRequirementLookup, method: string, template: string): RouteRequirement {
  const derived = table(method, template);
  if (!derived) throw new Error(`no route serves \`${method} ${template}\``);
  return derived;
}

describe("param spelling", () => {
  it("finds a route whose param carries an inline regex constraint", () => {
    const requirement = served(
      tableOf((sub) => sub.get("/things/:id{[0-9]+}", requirePermission("agents", "read"), ok)),
      "GET",
      "/api/things/{id}",
    );
    expect(requirement.requirements).toEqual(["agents:read"]);
  });

  it("finds one whose constraint itself contains a slash", () => {
    // `routes/integrations.ts` really mounts this: a package id is
    // `@scope/name`, so its constraint spans a path separator.
    const requirement = served(
      tableOf((sub) =>
        sub.patch(
          "/integrations/:packageId{@[^/]+/[^/]+}/settings",
          requirePermission("integrations", "write"),
          ok,
        ),
      ),
      "PATCH",
      "/api/integrations/{packageId}/settings",
    );
    expect(requirement.requirements).toEqual(["integrations:write"]);
  });
});

describe("lookup — exact mounts", () => {
  it("matches on the MERGED path, in the catalog's param spelling", () => {
    const requirement = served(
      tableOf((sub) =>
        sub.post("/agents/:scope/:name/run", requirePermission("agents", "run"), ok),
      ),
      "POST",
      "/api/agents/{scope}/{name}/run",
    );
    expect(requirement.requirements).toEqual(["agents:run"]);
    expect(requirement.targetSpaceRequirements).toEqual([]);
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

  it("takes the row-authority marker, not a bare guard stamp, for the row deciding", () => {
    // One way to say it: `requirePackageInOrg` carries the marker itself, and a
    // permission guard naming no requirement is not read as row-aware.
    expect(isRowAuthority(requirePackageInOrg())).toBe(true);
    const bareGuard = markHandler(
      async (_c: Context<AppEnv>, next: Next) => next(),
      PERMISSION_GUARD,
    );
    const requirement = served(
      tableOf((sub) => sub.delete("/things/:id", bareGuard, ok)),
      "DELETE",
      "/api/things/{id}",
    );
    expect(requirement.conditional).toBe(false);
  });

  it("reads an explicit `rowAuthority()` the same way — the handler decides", () => {
    // No guard runs before the handler at all: the row it loads is the only
    // authority, and nothing static describes it.
    const requirement = served(
      tableOf((sub) => sub.delete("/files/:id", rowAuthority(), ok)),
      "DELETE",
      "/api/files/{id}",
    );
    expect(requirement.requirements).toEqual([]);
    expect(requirement.targetSpaceRequirements).toEqual([]);
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

describe("lookup — prefix mounts", () => {
  it("serves everything under a wildcard mounted with a concrete method", () => {
    // The Better Auth family: one mount answers ~12 documented operations, and
    // "served, requires nothing" is not the same answer as "no such route".
    const requirement = served(
      rootTableOf((app) => app.on(["POST", "GET"], "/api/auth/*", ok)),
      "POST",
      "/api/auth/sign-in/email",
    );
    expect(requirement.requirements).toEqual([]);
    expect(requirement.conditional).toBe(false);
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
    // that way gates the collection route too.
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
    expect(table("POST", "/api/anything")).toBeUndefined();
  });

  it("decorates but does not serve, for an `ALL /*` mount", () => {
    const table = tableOf((sub) => {
      sub.use("/*", requirePackageInOrg());
      sub.get("/kept", ok);
    });
    expect(served(table, "GET", "/api/kept").conditional).toBe(true);
    expect(table("GET", "/api/never-mounted")).toBeUndefined();
  });

  it("does not serve a template no entry covers", () => {
    const table = tableOf((sub) => sub.get("/kept", ok));
    expect(table("GET", "/api/elsewhere")).toBeUndefined();
    expect(table("DELETE", "/api/kept")).toBeUndefined();
  });

  it("keeps a guard mounted as `ALL /*`, the SPA catch-all's path", () => {
    // `app.use("/*", …)` and the SPA fallback share a path and nothing else:
    // discarding both would drop a guard covering the whole app.
    const table = rootTableOf((app) => {
      app.use("/*", requirePermission("agents", "read"));
      app.post("/api/kept", ok);
    });
    expect(served(table, "POST", "/api/kept").requirements).toEqual(["agents:read"]);
    // Still decoration: it makes nothing exist on its own.
    expect(table("GET", "/api/never-mounted")).toBeUndefined();
  });

  it("never serves anything from the root catch-alls", () => {
    // `index.ts` mounts the `ALL /api/*` 404 and the SPA `GET /*` shell as
    // marked fallbacks. Reading either as a route would answer every template
    // ever spelled, publishing a ghost operation as real and unguarded.
    const table = rootTableOf((app) => {
      app.on(["POST", "GET"], "/api/auth/*", ok);
      app.all("/api/*", fallback());
      app.get("/*", fallback());
    });
    expect(table("GET", "/api/ghost")).toBeUndefined();
    expect(table("POST", "/api/ghost")).toBeUndefined();
    expect(table("GET", "/ghost")).toBeUndefined();
    // The control: a real prefix mount beneath the same catch-all still serves.
    expect(served(table, "POST", "/api/auth/sign-in/email").requirements).toEqual([]);
  });
});

describe("lookup — a terminal handler serves, middleware never does", () => {
  // Hono's route table spells `use("/x", mw)` and `all("/x", handler)` the same
  // (`ALL /x`); only the handler tells them apart. Each case was checked
  // against Hono itself: 404 exactly where the table answers `undefined`.
  it("serves no other method from an exact-path `use`", () => {
    const table = rootTableOf((app) => {
      app.use("/api/things/:id", requirePermission("agents", "read"));
      app.get("/api/things/:id", ok);
    });
    expect(served(table, "GET", "/api/things/{id}").requirements).toEqual(["agents:read"]);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(table(method, "/api/things/{id}")).toBeUndefined();
    }
  });

  it("serves the whole subtree of an `all` prefix mount with a terminal handler", () => {
    // A proxy: one mount answers every method beneath it, bare prefix included.
    const table = rootTableOf((app) => app.all("/api/proxy/*", ok));
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(served(table, method, "/api/proxy/{path}").requirements).toEqual([]);
    }
    expect(served(table, "GET", "/api/proxy").requirements).toEqual([]);
  });

  it("serves from an unmarked catch-all — the marker, not the path, excludes a fallback", () => {
    const unmarked = rootTableOf((app) => app.all("/api/*", ok));
    expect(served(unmarked, "POST", "/api/ghost").requirements).toEqual([]);
    const marked = rootTableOf((app) => app.get("/api/*", fallback()));
    expect(marked("GET", "/api/ghost")).toBeUndefined();
  });

  it("classifies through the wrapper `app.route()` adds for a sub-app's `onError`", () => {
    const app = mounted((sub) => {
      sub.use("/things/:id", requirePermission("agents", "read"));
      sub.get("/things/:id", ok);
      sub.all("/proxy/*", ok);
    });
    const table = deriveRouteRequirements(app.routes);
    expect(served(table, "GET", "/api/things/{id}").requirements).toEqual(["agents:read"]);
    expect(table("PUT", "/api/things/{id}")).toBeUndefined();
    expect(served(table, "DELETE", "/api/proxy/{path}").requirements).toEqual([]);
    // Fixture check: every handler copied here is a `(c, next)` wrapper, so
    // an arity read on the wrapper would take the proxy for middleware.
    const proxy = app.routes.find((route) => route.path === "/api/proxy/*")!;
    expect(proxy.handler.length).toBe(2);
  });
});

describe("lookup — segment by segment, as Hono matches", () => {
  // Each case below was checked against Hono itself: the guard answers 403 on
  // a concrete request exactly where the table reports it.
  const table = tableOf((sub) => {
    sub.use("/spaces/:spaceId/*", requirePermission("spaces", "read"));
    sub.get("/spaces/:id/members", ok);
    sub.get("/spaces/current/members", ok);
    sub.get("/spaces/:id", ok);
  });

  it("matches a mount param whatever the template names it", () => {
    expect(served(table, "GET", "/api/spaces/{id}/members").requirements).toEqual(["spaces:read"]);
  });

  it("covers a literal template segment with a mount param", () => {
    expect(served(table, "GET", "/api/spaces/current/members").requirements).toEqual([
      "spaces:read",
    ]);
  });

  it("covers the bare prefix of a param wildcard, and serves it from a param route", () => {
    expect(served(table, "GET", "/api/spaces/{id}").requirements).toEqual(["spaces:read"]);
    expect(served(table, "GET", "/api/spaces/x").requirements).toEqual(["spaces:read"]);
  });

  it("never covers a `{param}` template with a mount literal", () => {
    // The guard runs for `current` only; `{id}` also names every value it
    // skips, so attributing it would filter operations it never gates.
    const literalMount = tableOf((sub) => {
      sub.use("/spaces/current/*", requirePermission("spaces", "write"));
      sub.get("/spaces/:id/members", ok);
    });
    expect(served(literalMount, "GET", "/api/spaces/{id}/members").requirements).toEqual([]);
  });

  it("tests a constrained mount param against a literal, and covers a template param", () => {
    const constrained = tableOf((sub) => {
      sub.use("/things/:thingId{[0-9]+}/*", requirePermission("agents", "read"));
      sub.get("/things/42/logs", ok);
      sub.get("/things/latest/logs", ok);
      sub.get("/things/:id/logs", ok);
    });
    expect(served(constrained, "GET", "/api/things/42/logs").requirements).toEqual(["agents:read"]);
    expect(served(constrained, "GET", "/api/things/latest/logs").requirements).toEqual([]);
    expect(served(constrained, "GET", "/api/things/{id}/logs").requirements).toEqual([
      "agents:read",
    ]);
  });
});

describe("lookup — space re-scope", () => {
  /**
   * `routes/spaces.ts` resolves the space named in the PATH and re-applies the
   * caller's permissions in it, so the guards mounted after that are asked of
   * the target space — not of the space a reader holding the caller's own set
   * is talking about.
   */
  const table = rootTableOf((app) => {
    app.use("/api/x/:id/*", rescope());
    app.get("/api/x/:id/members", requirePermission("members", "read"), ok);
  });
  const requirement = served(table, "GET", "/api/x/{id}/members");

  it("attributes a guard mounted after the re-scope to the target space", () => {
    expect(requirement.targetSpaceRequirements).toEqual(["members:read"]);
    expect(requirement.requirements).toEqual([]);
  });

  it("marks the route conditional — the target space is what decides", () => {
    expect(requirement.conditional).toBe(true);
  });

  it("keeps a guard mounted BEFORE the re-scope in the caller's own space", () => {
    const early = served(
      rootTableOf((app) => {
        app.use("/api/x/*", requirePermission("spaces", "read"));
        app.use("/api/x/:id/*", rescope());
        app.get("/api/x/:id/members", requirePermission("members", "read"), ok);
      }),
      "GET",
      "/api/x/{id}/members",
    );
    expect(early.requirements).toEqual(["spaces:read"]);
    expect(early.targetSpaceRequirements).toEqual(["members:read"]);
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
  // `isGranted` is a pure function of a `RouteRequirement`, so these are
  // literals: how each shape is DERIVED is pinned by the blocks above, and
  // building five Hono apps here would only re-test that.
  const conjunction: RouteRequirement = {
    requirements: ["agents:write", "agents:run"],
    targetSpaceRequirements: [],
    conditional: false,
  };
  const disjunction: RouteRequirement = {
    requirements: ["runs:read|runs:read-all"],
    targetSpaceRequirements: [],
    conditional: false,
  };
  const rowAware: RouteRequirement = {
    requirements: [],
    targetSpaceRequirements: [],
    conditional: true,
  };
  const unguarded: RouteRequirement = {
    requirements: [],
    targetSpaceRequirements: [],
    conditional: false,
  };
  const targetSpace: RouteRequirement = {
    requirements: [],
    targetSpaceRequirements: ["members:read"],
    conditional: true,
  };

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

  it("grants an unguarded route to a caller holding nothing", () => {
    expect(isGranted(unguarded, new Set())).toBe(true);
  });

  it("grants a row-aware-only requirement — the row refuses, not the catalog", () => {
    // Plan rule 2: a row-dependent act stays visible and is described as
    // conditional; hiding it hides the page that explains the refusal.
    expect(isGranted(rowAware, new Set())).toBe(true);
  });

  it("ignores target-space requirements — they are shown, never filtered", () => {
    // The caller's own permission set is the wrong set to test them against:
    // the guard runs against the space the path names, so a caller holding
    // nothing here is still granted.
    expect(isGranted(targetSpace, new Set())).toBe(true);
  });
});
