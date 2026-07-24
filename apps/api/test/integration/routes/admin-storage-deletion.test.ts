// SPDX-License-Identifier: Apache-2.0

/**
 * Guard contract of the platform-operator storage-deletion outbox routes.
 *
 * The listing is instance-global — it returns the bucket + in-bucket key (which
 * encodes the owning application id and the stored filename) of objects
 * belonging to EVERY organization. So the only thing standing between an
 * arbitrary authenticated principal and a cross-org filename dump is
 * `requirePlatformAdmin`, and these tests pin its three independent
 * conditions:
 *
 *   1. session auth  — an OIDC/module-issued bearer is refused even when it
 *      resolves the very user whose email is allowlisted, and even when the
 *      token carries a broad permission set;
 *   2. `platform` realm — a Better Auth user from the shared end-user realm is
 *      refused, because its `email` is self-declared at signup;
 *   3. the `AUTH_PLATFORM_ADMIN_EMAILS` allowlist itself.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user as userTable, session as sessionTable } from "@appstrate/db/schema";
import { _resetCacheForTesting } from "@appstrate/env";
import type { AppstrateModule, AuthStrategy } from "@appstrate/core/module";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey } from "../../helpers/seed.ts";

const LIST_PATH = "/api/admin/storage-deletion-jobs";

/**
 * Stand-in for the OIDC module's dashboard strategy: a bearer token that
 * resolves a real platform user with a NON-session `authMethod` and
 * scope-derived permissions. This is the shape the old guard let through —
 * it only excluded `authMethod === "api_key"`.
 */
let currentCtx: TestContext | null = null;

const oidcLikeStrategy: AuthStrategy = {
  id: "oidc-like-test-strategy",
  async authenticate({ headers }) {
    if (headers.get("x-test-oidc") !== "1") return null;
    if (!currentCtx) throw new Error("currentCtx not seeded — test setup bug");
    return {
      user: {
        id: currentCtx.user.id,
        email: currentCtx.user.email,
        name: currentCtx.user.name,
      },
      orgId: currentCtx.orgId,
      orgSlug: currentCtx.org.slug,
      orgRole: "owner",
      authMethod: "oauth2-dashboard",
      applicationId: currentCtx.defaultAppId,
      // Deliberately generous: the point is that NO scope set substitutes for
      // an authentic platform session on this surface.
      permissions: ["org:read", "runs:read", "documents:read", "documents:delete"],
    };
  },
};

const oidcLikeModule: AppstrateModule = {
  manifest: { id: "oidc-like-strategy", name: "OIDC-like Strategy", version: "1.0.0" },
  async init() {},
  authStrategies() {
    return [oidcLikeStrategy];
  },
};

const app = getTestApp({ modules: [oidcLikeModule] });

describe("GET/POST /api/admin/storage-deletion-jobs — platform operator guard", () => {
  const prevAllowlist = process.env.AUTH_PLATFORM_ADMIN_EMAILS;

  beforeEach(async () => {
    await truncateAll();
    currentCtx = await createTestContext({ orgSlug: "adminops" });
    // The allowlist is read through the cached env, so set it AFTER the user
    // exists and reset the cache — same idiom as the documents suite.
    process.env.AUTH_PLATFORM_ADMIN_EMAILS = currentCtx.user.email;
    _resetCacheForTesting();
  });

  afterAll(() => {
    if (prevAllowlist === undefined) delete process.env.AUTH_PLATFORM_ADMIN_EMAILS;
    else process.env.AUTH_PLATFORM_ADMIN_EMAILS = prevAllowlist;
    _resetCacheForTesting();
    // Restore the discovered-module RBAC snapshot for the rest of the process
    // (getTestApp re-registers it on every call).
    getTestApp();
  });

  it("admits an allowlisted platform session", async () => {
    const ctx = currentCtx!;
    const res = await app.request(LIST_PATH, {
      headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("refuses a non-session token that resolves the allowlisted operator", async () => {
    const ctx = currentCtx!;
    // Same user, same allowlisted email, broad permissions — but the auth
    // method is a bearer token, not a first-party session.
    const res = await app.request(LIST_PATH, {
      headers: { "x-test-oidc": "1", "X-Org-Id": ctx.orgId },
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "forbidden" });

    const retry = await app.request(`${LIST_PATH}/sdj_whatever/retry`, {
      method: "POST",
      headers: { "x-test-oidc": "1", "X-Org-Id": ctx.orgId },
    });
    expect(retry.status).toBe(403);
  });

  it("refuses an API key minted by the allowlisted operator", async () => {
    const ctx = currentCtx!;
    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      scopes: ["runs:read"],
    });
    const res = await app.request(LIST_PATH, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a session whose realm is not `platform`, allowlisted email or not", async () => {
    // An end-user of a third-party application lives in the SAME Better Auth
    // user table and declares its own email at signup — so an allowlisted
    // address proves nothing without the realm. The realm the guard reads is
    // the one denormalized onto the SESSION row at creation time.
    const ctx = currentCtx!;
    const foreignRealm = `app:${ctx.defaultAppId}`;
    const lookalike = await createTestUser({ email: "operator-lookalike@test.com" });
    await addOrgMember(ctx.orgId, lookalike.id, "owner");
    await db.update(userTable).set({ realm: foreignRealm }).where(eq(userTable.id, lookalike.id));
    await db
      .update(sessionTable)
      .set({ realm: foreignRealm })
      .where(eq(sessionTable.userId, lookalike.id));
    process.env.AUTH_PLATFORM_ADMIN_EMAILS = `${ctx.user.email},${lookalike.email}`;
    _resetCacheForTesting();

    // Full, otherwise-valid request: org membership as owner, org header
    // present — only the realm differs.
    const res = await app.request(LIST_PATH, {
      headers: { Cookie: lookalike.cookie, "X-Org-Id": ctx.orgId },
    });
    expect(res.status).toBe(403);
  });

  it("refuses an authentic platform session that is not allowlisted", async () => {
    process.env.AUTH_PLATFORM_ADMIN_EMAILS = "someone-else@test.com";
    _resetCacheForTesting();
    const ctx = currentCtx!;
    const res = await app.request(LIST_PATH, {
      headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
    });
    expect(res.status).toBe(403);
  });
});
