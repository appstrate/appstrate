// SPDX-License-Identifier: Apache-2.0

/**
 * `operationRequirement` — the join from an operationId onto the permission its
 * route enforces; an operation the route table does not describe must FAIL
 * naming itself, since "no requirement" reads as "public". It registers the
 * SHARED test app because `setPlatformApp` is module-level state in a
 * one-process runner: a stand-in would answer for every later file, and for
 * the same reason the unregistered state is unassertable (it is file order).
 *
 * The whole-catalog join lives HERE rather than beside the allowlist in
 * `test/integration/middleware/route-requirements.test.ts`: that file is label
 * gated, and a spec-without-route PR would merge green and 500 in production.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { setPlatformApp } from "../../../../lib/platform-app.ts";
import { routeRequirementKey } from "../../../../lib/route-requirements.ts";
import {
  getCatalog,
  operationRequirement,
  resetCatalog,
  type CatalogOperation,
} from "../../catalog.ts";

setPlatformApp(getTestApp());

const ghost: CatalogOperation = {
  operationId: "ghostOperation",
  method: "POST",
  pathTemplate: "/api/nothing-mounts-this/{id}",
  tags: ["Other"],
  summary: "",
  description: "",
  pathParams: ["id"],
  headerParams: [],
  operation: { operationId: "ghostOperation" },
};

describe("operationRequirement", () => {
  beforeEach(() => resetCatalog());

  it("reads the guard mounted on a real operation's route", () => {
    const runAgent = getCatalog().operations.get("runAgent");
    expect(runAgent).toBeDefined();
    expect(operationRequirement(runAgent!).requirements).toContain("agents:run");
  });

  it("throws, naming the operationId, for an operation no route serves", () => {
    expect(() => operationRequirement(ghost)).toThrow(/ghostOperation/);
  });

  it("resolves the prefix-mounted Better Auth family too", () => {
    const signIn = getCatalog().operations.get("signInEmail");
    expect(signIn).toBeDefined();
    expect(operationRequirement(signIn!).requirements).toEqual([]);
  });
});

describe("every catalog operation joins onto a route", () => {
  beforeEach(() => resetCatalog());

  it("resolves a requirement for every operation, with no exception", () => {
    const unresolved: string[] = [];
    let resolved = 0;
    for (const operation of getCatalog().operations.values()) {
      try {
        operationRequirement(operation);
        resolved += 1;
      } catch {
        unresolved.push(
          `${operation.operationId} (${routeRequirementKey(operation.method, operation.pathTemplate)})`,
        );
      }
    }
    expect(unresolved).toEqual([]); // Names, not a count.
    // Control: a wholesale break would catch everything and still list none.
    expect(resolved).toBeGreaterThan(100);
  });
});
