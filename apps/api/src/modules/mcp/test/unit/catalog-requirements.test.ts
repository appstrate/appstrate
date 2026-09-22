// SPDX-License-Identifier: Apache-2.0

/**
 * The catalog's join from an operationId onto the permission its route
 * enforces. An operation the route table does not describe must FAIL naming
 * itself, since "no requirement" reads as "public" — so `getCatalog()` resolves
 * every operation up front and throws rather than shipping one unjoined.
 *
 * The whole-catalog join lives HERE rather than beside the allowlist in
 * `test/integration/middleware/route-requirements.test.ts`: that file is label
 * gated, and a spec-without-route PR would merge green and 500 in production.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { getPlatformRoutes } from "../../../../lib/platform-app.ts";
import { deriveRouteRequirements } from "../../../../lib/route-requirements.ts";
import { getCatalog, resetCatalog } from "../../catalog.ts";

registerTestPlatformApp();

describe("getCatalog — the route join", () => {
  beforeEach(() => resetCatalog());

  it("resolves a requirement for every operation, with no exception", () => {
    // Building the catalog at all is the assertion: one unjoined operation and
    // the call throws, naming it. The control is that it joined a real surface
    // rather than an empty one.
    const { operations } = getCatalog();
    expect(operations.size).toBeGreaterThan(100);
    for (const op of operations.values()) expect(op.requirement).toBeDefined();
  });

  it("reads the guard mounted on a real operation's route", () => {
    const runAgent = getCatalog().operations.get("runAgent");
    expect(runAgent).toBeDefined();
    expect(runAgent!.requirement.requirements).toContain("agents:run");
  });

  it("resolves the prefix-mounted Better Auth family too", () => {
    const signIn = getCatalog().operations.get("signInEmail");
    expect(signIn).toBeDefined();
    expect(signIn!.requirement.requirements).toEqual([]);
  });
});

describe("the lookup the catalog joins on", () => {
  it("answers undefined for a template no route serves", () => {
    // What makes the join above a failure rather than a silent grant: the
    // lookup reports "nothing serves this", and `getCatalog()` refuses to build.
    const requirementFor = deriveRouteRequirements(getPlatformRoutes());
    expect(requirementFor("POST", "/api/nothing-mounts-this/{id}")).toBeUndefined();
  });
});
