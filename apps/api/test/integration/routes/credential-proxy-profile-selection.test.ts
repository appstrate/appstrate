// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `resolveProfileId` (credential-proxy route
 * helper) — the per-call profile selector backing the new
 * `X-Connection-Profile-Id` header.
 *
 * The header lets the CLI/external runners pin a non-default profile
 * for a single proxy call without disturbing the user's app-level
 * default. Tests pin the ownership rules: a caller may use their own
 * user/end-user profile or an app profile in the request's
 * application; anything else surfaces as `null` so the route returns
 * a 404 (same shape as the implicit-default-not-found path).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedConnectionProfile } from "../../helpers/seed.ts";
import { resolveProfileId } from "../../../src/routes/credential-proxy.ts";

describe("credential-proxy resolveProfileId — explicit profile selection", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "cpprofile" });
  });

  it("returns the explicit id when it belongs to the calling user", async () => {
    const profile = await seedConnectionProfile({
      userId: ctx.user.id,
      name: "Work",
      isDefault: false,
    });
    const resolved = await resolveProfileId({
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      explicitProfileId: profile.id,
    });
    expect(resolved).toBe(profile.id);
  });

  it("returns the explicit id when it is an app profile in the requested app", async () => {
    const profile = await seedConnectionProfile({
      applicationId: ctx.defaultAppId,
      name: "App Profile",
      isDefault: false,
    });
    const resolved = await resolveProfileId({
      applicationId: ctx.defaultAppId,
      explicitProfileId: profile.id,
    });
    expect(resolved).toBe(profile.id);
  });

  it("returns null when the explicit id belongs to another user", async () => {
    // Seed a profile for a different real user — connection_profiles
    // FKs into the better-auth `user` table, so we need a sign-up.
    const otherUser = await createTestUser();
    const other = await seedConnectionProfile({
      userId: otherUser.id,
      name: "Other User Profile",
      isDefault: false,
    });
    const resolved = await resolveProfileId({
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      explicitProfileId: other.id,
    });
    expect(resolved).toBeNull();
  });

  it("returns null when the explicit id is unknown", async () => {
    const resolved = await resolveProfileId({
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      explicitProfileId: "00000000-0000-4000-8000-000000000000",
    });
    expect(resolved).toBeNull();
  });

  it("falls back to the implicit chain when explicitProfileId is unset", async () => {
    const userDefault = await seedConnectionProfile({
      userId: ctx.user.id,
      name: "Default",
      isDefault: true,
    });
    const resolved = await resolveProfileId({
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
    });
    expect(resolved).toBe(userDefault.id);
  });
});
