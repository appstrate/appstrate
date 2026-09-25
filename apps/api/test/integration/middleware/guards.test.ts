// SPDX-License-Identifier: Apache-2.0

/**
 * Guards middleware integration tests.
 *
 * Tests requireAgent via real HTTP routes and DB.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";

const app = getTestApp();

describe("requireAgent (via agent config route)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("loads agent when it exists", async () => {
    await seedPackage({
      id: "@testorg/my-agent",
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, "@testorg/my-agent");

    const res = await app.request("/api/agents/@testorg/my-agent/input-settings", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ values: {}, locked_fields: [] }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 when agent does not exist", async () => {
    const res = await app.request("/api/agents/@testorg/nonexistent/input-settings", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
