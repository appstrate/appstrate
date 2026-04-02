// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";

const app = getTestApp();

describe("org-context middleware", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("sets orgId when valid X-Org-Id header provided", async () => {
    // Use a route that requires org context (e.g., flows list)
    const res = await app.request("/api/flows", {
      headers: authHeaders(ctx),
    });
    // Should not get a 400 about missing X-Org-Id
    expect(res.status).not.toBe(400);
  });

  it("returns 400 when X-Org-Id header is missing", async () => {
    const res = await app.request("/api/flows", {
      headers: { Cookie: ctx.cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("invalid_request");
    expect(body.detail).toContain("X-Org-Id");
  });

  it("returns 403 when user is not a member of the org", async () => {
    // Create a different user who is NOT a member of ctx.org
    const otherUser = await createTestUser();

    const res = await app.request("/api/flows", {
      headers: {
        Cookie: otherUser.cookie,
        "X-Org-Id": ctx.orgId,
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe("forbidden");
    expect(body.detail).toContain("not a member");
  });

  it("returns 403 with non-existent org ID", async () => {
    const res = await app.request("/api/flows", {
      headers: {
        Cookie: ctx.cookie,
        "X-Org-Id": "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(res.status).toBe(403);
  });

  it("skips org context for org management routes", async () => {
    // GET /api/orgs should work without X-Org-Id
    const res = await app.request("/api/orgs", {
      headers: { Cookie: ctx.cookie },
    });
    // Should not fail with 400 about missing X-Org-Id
    expect(res.status).not.toBe(400);
  });

  it("skips org context for profile routes", async () => {
    const res = await app.request("/api/profile", {
      headers: { Cookie: ctx.cookie },
    });
    expect(res.status).not.toBe(400);
  });

  it("returns 401 without any authentication", async () => {
    const res = await app.request("/api/flows");
    expect(res.status).toBe(401);
  });
});
