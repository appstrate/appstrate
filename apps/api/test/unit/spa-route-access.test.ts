// SPDX-License-Identifier: Apache-2.0

/**
 * The SPA's route declarations (`apps/web/src/lib/route-access.ts`) pinned to
 * the guards the route table derives for the operations each page is built on:
 * asking for more hides a usable page, asking for less opens a page of 403s.
 */

import { describe, it, expect } from "bun:test";
import { registerTestPlatformApp } from "../helpers/platform-app.ts";
import { getPlatformOperations } from "../../src/lib/platform-app.ts";
import type { AppstrateModule } from "@appstrate/core/module";
import { getModules } from "../../src/lib/modules/module-loader.ts";
import { getDeclinedModuleEntries } from "../helpers/test-modules.ts";
import { ROUTE_ACCESS } from "../../../web/src/lib/route-access.ts";

await registerTestPlatformApp();

/** Guarded in the handler, invisible to the route table; a route guard added later re-pins them. */
const HANDLER_GUARDED: Record<string, string> = {
  getOrganization: "membership only; `buildOrgDetail` returns the member list under `members:read`",
  getWebhook: "the row's level picks webhooks vs org-webhooks (`loadWebhookForAction`)",
};

const operations = new Map(getPlatformOperations().operations.map((op) => [op.operationId, op]));

const featuresOf = (mods: Iterable<AppstrateModule | undefined>) =>
  new Set([...mods].flatMap((mod) => Object.keys(mod?.features ?? {})));

const loadedFeatures = featuresOf(getModules().values());
// Imported, never initialised: `features` is a static field of the export.
const declinedFeatures = featuresOf(
  await Promise.all(
    getDeclinedModuleEntries().map(
      async (entry) => ((await import(entry)) as { default?: AppstrateModule }).default,
    ),
  ),
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
    // Only a module the harness declined for its tier may leave a flag unloaded.
    const missing = [...flags].filter((flag) => !loadedFeatures.has(flag)).sort();
    expect(missing).toEqual([...flags].filter((flag) => declinedFeatures.has(flag)).sort());
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
