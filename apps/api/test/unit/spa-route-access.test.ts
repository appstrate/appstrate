// SPDX-License-Identifier: Apache-2.0

/**
 * The SPA's route declarations (`apps/web/src/lib/route-access.ts`) pinned to
 * the guards the route table derives for the operations each page is built on:
 * asking for more hides a usable page, asking for less opens a page of 403s.
 */

import { describe, it, expect } from "bun:test";
import { registerTestPlatformApp } from "../helpers/platform-app.ts";
import { getPlatformOperations } from "../../src/lib/platform-app.ts";
import { getModules } from "../../src/lib/modules/module-loader.ts";
import { ROUTE_ACCESS } from "../../../web/src/lib/route-access.ts";

await registerTestPlatformApp();

/** Guarded in the handler, invisible to the route table; a route guard added later re-pins them. */
const HANDLER_GUARDED: Record<string, string> = {
  getOrganization: "membership only; `buildOrgDetail` returns the member list under `members:read`",
  getWebhook: "the row's level picks webhooks vs org-webhooks (`loadWebhookForAction`)",
};

const operations = new Map(getPlatformOperations().operations.map((op) => [op.operationId, op]));

const loadedFeatures = new Set(
  [...getModules().values()].flatMap((mod) => Object.keys(mod.features ?? {})),
);

type Declaration = {
  feature?: string;
  open?: string;
  anyOf?: readonly string[];
  operations?: readonly string[];
};
const gated = Object.entries(ROUTE_ACCESS).flatMap(([path, access]: [string, Declaration]) =>
  access.anyOf && access.operations
    ? [{ path, feature: access.feature, anyOf: access.anyOf, operations: access.operations }]
    : [],
);

describe("SPA route declarations ↔ API guards", () => {
  it("declares a module flag the harness knows, or names the one it could not load", () => {
    const flags = new Set(gated.flatMap((route) => (route.feature ? [route.feature] : [])));
    expect(flags.size).toBeGreaterThan(0);
    // module-ee needs a real PostgreSQL (its `test/requirements.ts`), so the
    // tier-0 harness does not load it; every other module's flag must be live.
    const missing = [...flags].filter((flag) => !loadedFeatures.has(flag));
    expect(missing).toEqual(process.env.TEST_TIER === "0" ? ["billing"] : []);
  });

  for (const route of gated) {
    const unloaded = route.feature !== undefined && !loadedFeatures.has(route.feature);
    it.skipIf(unloaded)(`${route.path} opens on exactly its operations' guards`, () => {
      const union = new Set<string>();
      for (const operationId of route.operations) {
        const op = operations.get(operationId);
        expect({ operationId, served: op !== undefined }).toEqual({ operationId, served: true });
        const { requirements, targetSpaceRequirements } = op!.requirement;
        // The SPA's current space is the one a re-scoped path names.
        const guards = [...requirements, ...targetSpaceRequirements];
        if (operationId in HANDLER_GUARDED) {
          expect({ operationId, guards }).toEqual({ operationId, guards: [] });
          continue;
        }
        // `anyOf` cannot express an operation needing two grants at once.
        expect({ operationId, guards: guards.length }).toEqual({ operationId, guards: 1 });
        for (const permission of guards[0]!.split("|")) union.add(permission);
      }
      const pinned = route.operations.some((id) => !(id in HANDLER_GUARDED));
      if (pinned) expect([...route.anyOf].sort()).toEqual([...union].sort());
    });
  }
});
