// SPDX-License-Identifier: Apache-2.0

/**
 * Guards middleware integration tests.
 *
 * Tests requireAgent and requireMutableAgent via real HTTP routes and DB.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";

const app = getTestApp();

describe("requireAgent (via agent config route)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("loads agent when it exists", async () => {
    await seedPackage({ id: "@testorg/my-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage(ctx.defaultAppId, ctx.orgId, "@testorg/my-agent");

    const res = await app.request("/api/agents/@testorg/my-agent/config", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 when agent does not exist", async () => {
    const res = await app.request("/api/agents/@testorg/nonexistent/config", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("requireMutableAgent (via agent skills route)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("allows modification of local agent with no running runs", async () => {
    await seedPackage({ id: "@testorg/my-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage(ctx.defaultAppId, ctx.orgId, "@testorg/my-agent");

    const res = await app.request("/api/agents/@testorg/my-agent/skills", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds: [] }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects modification of agent with running runs (409)", async () => {
    await seedPackage({ id: "@testorg/busy-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage(ctx.defaultAppId, ctx.orgId, "@testorg/busy-agent");

    await seedRun({
      packageId: "@testorg/busy-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "running",
    });

    const res = await app.request("/api/agents/@testorg/busy-agent/skills", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds: [] }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe("agent_in_use");
  });
});
