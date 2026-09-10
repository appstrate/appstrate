// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-lookup ordering guard (#1341).
 *
 * `requireAgent()` / `requireOrgAgent()` resolve an agent from the route params
 * and 404 when it is unreachable from the caller's space. Mounted BEFORE the
 * route's permission guard, that 404 answers "does this agent exist?" to a
 * caller who was never allowed to ask: 403 means the agent exists, 404 means it
 * does not, and an API key scoped to some unrelated permission can walk the
 * space's private agent catalog.
 *
 * The rule is therefore: on every route, a permission guard is mounted before
 * any agent lookup. It is a property of the mount ORDER — invisible at runtime,
 * invisible in a diff that adds one more route by copying its neighbour — so it
 * is asserted here against Hono's real route table rather than trusted to
 * review. Eleven routes had it backwards when this test was written.
 */

import { describe, it, expect } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { isAgentLookup, requireAgent } from "../../../src/middleware/guards.ts";
import {
  isPermissionGuard,
  requirePermission,
} from "../../../src/middleware/require-permission.ts";

/**
 * Every registered route, as `"METHOD /path" -> handlers in mount order`.
 *
 * Hono pushes one `routes` entry per handler, in registration order, so
 * grouping by method+path recovers each route's chain. Grouping on the EXACT
 * path is what makes the assertion meaningful: app-wide middleware mounted on
 * `/*` forms its own group and can never be mistaken for a permission guard
 * standing in front of a lookup on a concrete route.
 */
function routeChains(): Map<string, unknown[]> {
  const chains = new Map<string, unknown[]>();
  for (const route of getTestApp().routes) {
    const key = `${route.method} ${route.path}`;
    const chain = chains.get(key);
    if (chain) chain.push(route.handler);
    else chains.set(key, [route.handler]);
  }
  return chains;
}

/** Routes that mount an agent lookup with no permission guard ahead of it. */
function offendingRoutes(): string[] {
  const offenders: string[] = [];
  for (const [key, chain] of routeChains()) {
    const lookupAt = chain.findIndex(isAgentLookup);
    if (lookupAt === -1) continue;
    const guardAt = chain.findIndex(isPermissionGuard);
    if (guardAt === -1 || guardAt > lookupAt) offenders.push(key);
  }
  return offenders.sort();
}

describe("agent lookup never precedes the permission guard", () => {
  it("mounts a permission guard before every agent lookup", () => {
    // Empty list, not a count: a regression names the route it broke.
    expect(offendingRoutes()).toEqual([]);
  });

  it("keeps both markers readable — the assertion has something to read", () => {
    // If either marker stopped being stamped, `offendingRoutes()` would return
    // an empty array for the wrong reason and this file would pass forever
    // against an unguarded API. Prove both halves are actually observable.
    const chains = [...routeChains().values()];
    expect(chains.filter((chain) => chain.some(isAgentLookup)).length).toBeGreaterThan(0);
    expect(chains.filter((chain) => chain.some(isPermissionGuard)).length).toBeGreaterThan(0);
  });

  it("detects a lookup mounted ahead of its guard", () => {
    // Negative control for `offendingRoutes`: the detector must fail on the
    // shape this issue was about, or the assertion above proves nothing.
    const bad = [requireAgent(), requirePermission("agents", "read")];
    const good = [requirePermission("agents", "read"), requireAgent()];

    const firstLookup = (chain: unknown[]) => chain.findIndex(isAgentLookup);
    const firstGuard = (chain: unknown[]) => chain.findIndex(isPermissionGuard);

    expect(firstGuard(bad) > firstLookup(bad)).toBe(true);
    expect(firstGuard(good) < firstLookup(good)).toBe(true);
  });
});
