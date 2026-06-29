// SPDX-License-Identifier: Apache-2.0

/**
 * Auth-conditional header guard — `Appstrate-User`.
 *
 * `Appstrate-User` end-user impersonation is honored ONLY under API-key auth.
 * Under any other auth method it has no effect, so the central guard in
 * `auth-pipeline.ts` (AUTH_CONDITIONAL_HEADERS) rejects it with
 * `400 header_not_allowed` instead of silently ignoring it. Previously this
 * rule lived per-branch and had drifted: cookie auth 400'd, the OAuth/strategy
 * branch silently ignored the header.
 *
 * These tests pin both sides of the guard:
 *   - non-API-key auth (cookie/session) + header → 400 header_not_allowed
 *   - API-key auth is NOT preempted: bad-prefix header still reaches the
 *     API-key branch's own validation, and a valid end-user still impersonates
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey, seedEndUser } from "../../helpers/seed.ts";

const app = getTestApp();

describe("auth-conditional header guard (Appstrate-User)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "guardorg" });
  });

  it("rejects Appstrate-User under cookie/session auth with 400 header_not_allowed", async () => {
    const res = await app.request("/api/runs", {
      headers: { ...authHeaders(ctx), "Appstrate-User": "eu_anything" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; param?: string };
    expect(body.code).toBe("header_not_allowed");
    expect(body.param).toBe("Appstrate-User");
  });

  it("does not preempt the API-key branch: a bad-prefix header is handled there, not by the guard", async () => {
    const apiKey = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      name: "guard-key-badprefix",
    });

    const res = await app.request("/api/runs", {
      headers: {
        Authorization: `Bearer ${apiKey.rawKey}`,
        "X-Application-Id": ctx.defaultAppId,
        "Appstrate-User": "not-an-eu-id",
      },
    });

    // The API-key branch validates the eu_ prefix itself and rejects first —
    // the guard must NOT shadow it with header_not_allowed.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).not.toBe("header_not_allowed");
  });

  it("honors Appstrate-User impersonation under API-key auth (valid end-user → 200)", async () => {
    const endUser = await seedEndUser({
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      externalId: "ext-guard-eu",
    });
    const apiKey = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      name: "guard-key-valid",
    });

    const res = await app.request("/api/runs", {
      headers: {
        Authorization: `Bearer ${apiKey.rawKey}`,
        "X-Application-Id": ctx.defaultAppId,
        "Appstrate-User": endUser.id,
      },
    });

    expect(res.status).toBe(200);
  });
});
