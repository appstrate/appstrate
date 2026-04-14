// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the OIDC enduser-mapping service.
 *
 * Exercises the three-step resolution order with real Postgres:
 *   1. already linked via oidc_end_user_profiles.authUserId
 *   2. email-match on an unlinked API-created end-user (verified email only)
 *   3. fresh create with shadow profile row
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { endUsers, applications } from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../../test/helpers/auth.ts";
import {
  resolveOrCreateEndUser,
  lookupEndUser,
  UnverifiedEmailConflictError,
  AppSignupClosedError,
} from "../../../services/enduser-mapping.ts";
import { oidcEndUserProfiles } from "../../../schema.ts";
import { prefixedId } from "../../../../../lib/ids.ts";

describe("resolveOrCreateEndUser", () => {
  let orgId: string;
  let applicationId: string;
  let authUserId: string;

  beforeEach(async () => {
    await truncateAll();
    const { id } = await createTestUser();
    const { org, defaultAppId } = await createTestOrg(id, { slug: "oidctest" });
    orgId = org.id;
    applicationId = defaultAppId;

    // Create a second auth identity representing the end-user
    // (distinct from the owning member's identity — this simulates a real
    // OAuth flow where an external end-user signed up via the login page).
    const { id: euAuthId } = await createTestUser({
      email: "enduser1@example.com",
      name: "End User One",
    });
    authUserId = euAuthId;
  });

  it("creates a fresh end-user + profile row on first sight", async () => {
    const resolved = await resolveOrCreateEndUser(
      {
        id: authUserId,
        email: "enduser1@example.com",
        name: "End User One",
        emailVerified: true,
      },
      applicationId,
      { allowSignup: true },
    );
    expect(resolved.endUserId).toStartWith("eu_");
    expect(resolved.applicationId).toBe(applicationId);
    expect(resolved.orgId).toBe(orgId);
    expect(resolved.email).toBe("enduser1@example.com");

    // Shadow profile row exists and links to the auth identity.
    const [profile] = await db
      .select()
      .from(oidcEndUserProfiles)
      .where(eq(oidcEndUserProfiles.endUserId, resolved.endUserId));
    expect(profile).toBeDefined();
    expect(profile!.authUserId).toBe(authUserId);
    expect(profile!.emailVerified).toBe(true);
    expect(profile!.status).toBe("active");
  });

  it("returns the existing end-user on second call (step 1: already linked)", async () => {
    const first = await resolveOrCreateEndUser(
      {
        id: authUserId,
        email: "enduser1@example.com",
        emailVerified: true,
      },
      applicationId,
      { allowSignup: true },
    );
    const second = await resolveOrCreateEndUser(
      {
        id: authUserId,
        email: "enduser1@example.com",
        emailVerified: true,
      },
      applicationId,
      { allowSignup: true },
    );
    expect(second.endUserId).toBe(first.endUserId);

    // And only one shadow profile row exists.
    const profiles = await db
      .select()
      .from(oidcEndUserProfiles)
      .where(eq(oidcEndUserProfiles.endUserId, first.endUserId));
    expect(profiles.length).toBe(1);
  });

  it("adopts an API-created end-user with matching verified email (step 2)", async () => {
    // Pre-seed an end-user via the admin API path (no profile row).
    const seededId = prefixedId("eu");
    await db.insert(endUsers).values({
      id: seededId,
      applicationId,
      orgId,
      email: "enduser1@example.com",
      name: "API Created",
    });
    // Sanity: no profile row yet.
    const before = await db
      .select()
      .from(oidcEndUserProfiles)
      .where(eq(oidcEndUserProfiles.endUserId, seededId));
    expect(before.length).toBe(0);

    const resolved = await resolveOrCreateEndUser(
      {
        id: authUserId,
        email: "enduser1@example.com",
        emailVerified: true,
      },
      applicationId,
      { allowSignup: true },
    );
    expect(resolved.endUserId).toBe(seededId);

    // Profile row got created and linked atomically.
    const [profile] = await db
      .select()
      .from(oidcEndUserProfiles)
      .where(eq(oidcEndUserProfiles.endUserId, seededId));
    expect(profile).toBeDefined();
    expect(profile!.authUserId).toBe(authUserId);
    expect(profile!.emailVerified).toBe(true);
  });

  it("refuses to adopt when email is not strictly verified (emailVerified = false)", async () => {
    const seededId = prefixedId("eu");
    await db.insert(endUsers).values({
      id: seededId,
      applicationId,
      orgId,
      email: "enduser1@example.com",
      name: "API Created",
    });
    await expect(
      resolveOrCreateEndUser(
        {
          id: authUserId,
          email: "enduser1@example.com",
          emailVerified: false,
        },
        applicationId,
        { allowSignup: true },
      ),
    ).rejects.toBeInstanceOf(UnverifiedEmailConflictError);
  });

  it("refuses to adopt when emailVerified is undefined (strict guard)", async () => {
    const seededId = prefixedId("eu");
    await db.insert(endUsers).values({
      id: seededId,
      applicationId,
      orgId,
      email: "enduser1@example.com",
      name: "API Created",
    });
    await expect(
      resolveOrCreateEndUser(
        {
          id: authUserId,
          email: "enduser1@example.com",
          // emailVerified omitted → unverified → conflict.
        },
        applicationId,
        { allowSignup: true },
      ),
    ).rejects.toBeInstanceOf(UnverifiedEmailConflictError);
  });

  it("creates a fresh end-user with an unverified email when no clash exists", async () => {
    const resolved = await resolveOrCreateEndUser(
      {
        id: authUserId,
        email: "enduser1@example.com",
        // No existing clash in this freshly-truncated DB → create succeeds.
        emailVerified: false,
      },
      applicationId,
      { allowSignup: true },
    );
    expect(resolved.endUserId).toStartWith("eu_");
  });

  it("isolates profiles per application", async () => {
    // Two apps in the same org: authUserId gets a different end_users row in each.
    const { org, defaultAppId: appA } = await createTestOrg((await createTestUser()).id, {
      slug: "orga",
    });
    expect(org).toBeDefined();
    const secondUser = await createTestUser({ email: "two@example.com" });
    const { defaultAppId: appB } = await createTestOrg(secondUser.id, { slug: "orgb" });

    const [inA, inB] = await Promise.all([
      resolveOrCreateEndUser(
        { id: authUserId, email: "enduser1@example.com", emailVerified: true },
        appA,
        { allowSignup: true },
      ),
      resolveOrCreateEndUser(
        { id: authUserId, email: "enduser1@example.com", emailVerified: true },
        appB,
        { allowSignup: true },
      ),
    ]);
    expect(inA.endUserId).not.toBe(inB.endUserId);
    expect(inA.applicationId).toBe(appA);
    expect(inB.applicationId).toBe(appB);
  });

  it("rejects unknown application IDs with a clear error", async () => {
    await expect(
      resolveOrCreateEndUser(
        { id: authUserId, email: "enduser1@example.com", emailVerified: true },
        "app_does_not_exist",
        { allowSignup: true },
      ),
    ).rejects.toThrow(/application 'app_does_not_exist' not found/);
  });

  describe("allowSignup policy", () => {
    it("blocks fresh end-user creation when allowSignup=false", async () => {
      await expect(
        resolveOrCreateEndUser(
          { id: authUserId, email: "enduser1@example.com", emailVerified: true },
          applicationId,
          { allowSignup: false },
        ),
      ).rejects.toBeInstanceOf(AppSignupClosedError);

      // And no end_users / profile row was created as a side effect.
      const rows = await db
        .select()
        .from(endUsers)
        .where(eq(endUsers.applicationId, applicationId));
      expect(rows.length).toBe(0);
    });

    it("still adopts a pre-created end_users row even with allowSignup=false", async () => {
      // Admin pre-creates the end-user via the headless API path. The JIT
      // gate only applies to step 3 (fresh creation) — step 2 (verified
      // email adoption) succeeds because the row already exists.
      const seededId = prefixedId("eu");
      await db.insert(endUsers).values({
        id: seededId,
        applicationId,
        orgId,
        email: "enduser1@example.com",
        name: "Pre-created",
      });
      const resolved = await resolveOrCreateEndUser(
        { id: authUserId, email: "enduser1@example.com", emailVerified: true },
        applicationId,
        { allowSignup: false },
      );
      expect(resolved.endUserId).toBe(seededId);
    });

    it("returns already-linked end-user even with allowSignup=false (step 1 short-circuit)", async () => {
      // Bootstrap the link with the flag ON, then re-resolve with flag OFF —
      // the existing profile row short-circuits at step 1 before the gate.
      const first = await resolveOrCreateEndUser(
        { id: authUserId, email: "enduser1@example.com", emailVerified: true },
        applicationId,
        { allowSignup: true },
      );
      const second = await resolveOrCreateEndUser(
        { id: authUserId, email: "enduser1@example.com", emailVerified: true },
        applicationId,
        { allowSignup: false },
      );
      expect(second.endUserId).toBe(first.endUserId);
    });
  });
});

describe("lookupEndUser", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("returns null when the end-user does not exist", async () => {
    expect(await lookupEndUser("eu_missing")).toBeNull();
  });

  it("returns the end-user plus profile status when it exists", async () => {
    const { id } = await createTestUser();
    const { org, defaultAppId } = await createTestOrg(id, { slug: "lookup" });
    const { id: euAuthId } = await createTestUser({ email: "lookup@example.com" });
    const resolved = await resolveOrCreateEndUser(
      { id: euAuthId, email: "lookup@example.com", emailVerified: true },
      defaultAppId,
      { allowSignup: true },
    );
    const looked = await lookupEndUser(resolved.endUserId);
    expect(looked).not.toBeNull();
    expect(looked!.endUserId).toBe(resolved.endUserId);
    expect(looked!.applicationId).toBe(defaultAppId);
    expect(looked!.orgId).toBe(org.id);
    expect(looked!.status).toBe("active");
  });

  it("returns active status when no profile row exists (LEFT JOIN fallback)", async () => {
    const { id } = await createTestUser();
    const { defaultAppId } = await createTestOrg(id, { slug: "fallback" });
    const [app] = await db
      .select({ orgId: applications.orgId })
      .from(applications)
      .where(eq(applications.id, defaultAppId))
      .limit(1);

    const seededId = prefixedId("eu");
    await db.insert(endUsers).values({
      id: seededId,
      applicationId: defaultAppId,
      orgId: app!.orgId,
      email: "no-profile@example.com",
    });

    const looked = await lookupEndUser(seededId);
    expect(looked).not.toBeNull();
    expect(looked!.status).toBe("active"); // LEFT JOIN fallback default
  });
});
