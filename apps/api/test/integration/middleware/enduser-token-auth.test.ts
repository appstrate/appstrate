// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("End-user JWT auth middleware", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("falls through to cookie auth when JWT is invalid", async () => {
    // Invalid JWT (starts with ey but isn't valid) → should fall through to cookie
    const res = await app.request("/api/end-users", {
      headers: {
        ...authHeaders(ctx),
        Authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.invalid.signature",
      },
    });
    // Cookie auth succeeds → 200 (end-users list)
    expect(res.status).toBe(200);
  });

  it("returns 401 when JWT is invalid and no cookie", async () => {
    const res = await app.request("/api/end-users", {
      headers: {
        "X-Org-Id": ctx.orgId,
        "X-App-Id": ctx.defaultAppId,
        Authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.invalid.signature",
      },
    });
    expect(res.status).toBe(401);
  });

  it("preserves existing API key auth (Bearer ask_ prefix)", async () => {
    // API key auth should still work unchanged
    const res = await app.request("/api/end-users", {
      headers: {
        Authorization: "Bearer ask_invalid_key_12345678901234567890",
      },
    });
    // Invalid API key → 401
    expect(res.status).toBe(401);
  });

  it("preserves existing cookie auth", async () => {
    const res = await app.request("/api/end-users", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
  });
});
