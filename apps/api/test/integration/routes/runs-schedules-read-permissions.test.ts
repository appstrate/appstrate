// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC on the run + schedule READ surface.
 *
 * `runs:read` and `schedules:read` were defined in the core catalog, granted by
 * every org role, and accepted as API-key scopes — and enforced by **no route**.
 * `requirePermission("runs", "read")` appeared nowhere in the codebase; the only
 * consumer of the permission was `/api/realtime/runs`, which checks the scope
 * set by hand. So a key minted with the narrowest possible scopes — even
 * `scopes: []`, which `validateScopes` accepts — was 403'd on `/api/realtime/runs`
 * and on `/api/files`, and still read every run, every run log and every schedule
 * of the application. `requireAgent()` on the two agent-scoped routes is a
 * resolver, not a gate.
 *
 * Two places in the tree asserted the opposite of the code, which is what makes
 * this worth pinning rather than fixing quietly: `routes/files.ts` justifies its
 * own `files:read` guard with "Exactly what `runs:read` does for runs", and the
 * API-key OpenAPI example advertises `scopes: ["agents:run", "runs:read"]`.
 *
 * Pinned per route rather than once: the value of the fix is that the surface is
 * coherent, so a new `router.get` registered without the guard has to fail here.
 *
 * A scoped API key is the only credential that can express "authenticated for
 * this org and app, without `runs:read`" — every org ROLE down to `viewer`
 * carries both scopes, which is exactly why the gap was invisible from the SPA.
 */

import { describe, it, expect, beforeEach, beforeAll } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  seedPackage,
  seedInstalledPackage,
  seedRun,
  seedSchedule,
  seedApiKey,
} from "../../helpers/seed.ts";

const app = getTestApp();

const AGENT_ID = "@testorg/read-guard-agent";

describe("run + schedule GET routes — read permission", () => {
  let ctx: TestContext;
  let runId: string;
  let scheduleId: string;

  beforeAll(async () => {
    await truncateAll();
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });

    await seedPackage({
      id: AGENT_ID,
      type: "agent",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: { name: AGENT_ID, version: "0.1.0", type: "agent" },
    });
    await seedInstalledPackage(ctx.defaultAppId, AGENT_ID);

    const run = await seedRun({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      packageId: AGENT_ID,
      userId: ctx.user.id,
      status: "success",
    });
    runId = run.id;

    const schedule = await seedSchedule({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      packageId: AGENT_ID,
      userId: ctx.user.id,
      enabled: true,
      nextRunAt: new Date(Date.now() + 3600_000),
    });
    scheduleId = schedule.id;
  });

  /** Every GET the two guards now cover, with the label the failure reports. */
  function readRoutes(): { label: string; path: string }[] {
    return [
      { label: "GET /api/runs", path: "/api/runs" },
      { label: "GET /api/runs/:id", path: `/api/runs/${runId}` },
      { label: "GET /api/runs/:id/logs", path: `/api/runs/${runId}/logs` },
      {
        label: "GET /api/agents/:scope/:name/runs",
        path: `/api/agents/${encodeURIComponent("@testorg")}/read-guard-agent/runs`,
      },
      { label: "GET /api/schedules", path: "/api/schedules" },
      { label: "GET /api/schedules/:id", path: `/api/schedules/${scheduleId}` },
      { label: "GET /api/schedules/:id/runs", path: `/api/schedules/${scheduleId}/runs` },
      {
        label: "GET /api/agents/:scope/:name/schedules",
        path: `/api/agents/${encodeURIComponent("@testorg")}/read-guard-agent/schedules`,
      },
    ];
  }

  /** Authenticated for the org + app, holding neither read scope. */
  async function keyWithoutReads(): Promise<string> {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      scopes: ["agents:run"],
    });
    return key.rawKey;
  }

  async function keyWithReads(): Promise<string> {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      scopes: ["runs:read", "schedules:read", "agents:read"],
    });
    return key.rawKey;
  }

  it("403s every run and schedule GET for a key holding neither read scope", async () => {
    const rawKey = await keyWithoutReads();

    for (const route of readRoutes()) {
      const res = await app.request(route.path, {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 403`);
    }
  });

  it("403s a key minted with no scopes at all", async () => {
    // `validateScopes` accepts `scopes: []` — it only rejects UNGRANTABLE
    // scopes — and the API-key branch of the auth pipeline then sets an empty
    // permission set with no early rejection. This was the sharpest form of the
    // gap: the narrowest credential the platform can mint read everything here.
    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      scopes: [],
    });

    for (const route of readRoutes()) {
      const res = await app.request(route.path, {
        headers: { Authorization: `Bearer ${key.rawKey}` },
      });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 403`);
    }
  });

  it("serves the same GETs once the key holds the read scopes", async () => {
    // The control that makes the assertions above non-vacuous: the same routes,
    // the same seeded data, a credential that differs only in its scope set.
    const rawKey = await keyWithReads();

    for (const route of readRoutes()) {
      const res = await app.request(route.path, {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 200`);
    }
  });

  it("keeps org-role sessions unaffected (every role carries both read scopes)", async () => {
    for (const route of readRoutes()) {
      const res = await app.request(route.path, { headers: authHeaders(ctx) });
      expect(`${route.label}: ${res.status}`).toBe(`${route.label}: 200`);
    }
  });
});
