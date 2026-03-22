/**
 * Guards middleware integration tests.
 *
 * Tests requireFlow and requireMutableFlow via real HTTP routes and DB.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedExecution } from "../../helpers/seed.ts";

const app = getTestApp();

describe("requireFlow (via flow config route)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("loads flow when it exists", async () => {
    await seedPackage({ id: "@testorg/my-flow", orgId: ctx.orgId, createdBy: ctx.user.id });

    const res = await app.request("/api/flows/@testorg/my-flow/config", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 when flow does not exist", async () => {
    const res = await app.request("/api/flows/@testorg/nonexistent/config", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("requireMutableFlow (via flow skills route)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("allows modification of local flow with no running executions", async () => {
    await seedPackage({ id: "@testorg/my-flow", orgId: ctx.orgId, createdBy: ctx.user.id });

    const res = await app.request("/api/flows/@testorg/my-flow/skills", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds: [] }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects modification of flow with running executions (409)", async () => {
    await seedPackage({ id: "@testorg/busy-flow", orgId: ctx.orgId, createdBy: ctx.user.id });

    await seedExecution({
      packageId: "@testorg/busy-flow",
      orgId: ctx.orgId,
      userId: ctx.user.id,
      status: "running",
    });

    const res = await app.request("/api/flows/@testorg/busy-flow/skills", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ skillIds: [] }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe("flow_in_use");
  });
});
