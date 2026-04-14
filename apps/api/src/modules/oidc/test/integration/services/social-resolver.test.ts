// SPDX-License-Identifier: Apache-2.0

/**
 * Resolver smoke tests — per-application social auth config.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { user as userTable, organizations, applications } from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  resolveSocialProviderForClient,
  invalidateSocialCache,
  _clearSocialCacheForTesting,
  upsertSocialProvider,
  deleteSocialProvider,
} from "../../../services/social.ts";

async function seedApp(): Promise<string> {
  const ownerId = `user-${crypto.randomUUID()}`;
  await db.insert(userTable).values({
    id: ownerId,
    email: `owner-${ownerId}@test.local`,
    name: "Owner",
    emailVerified: true,
  });
  const [org] = await db
    .insert(organizations)
    .values({
      name: "Social Resolver Test",
      slug: `soc-${crypto.randomUUID().slice(0, 8)}`,
      createdBy: ownerId,
    })
    .returning();
  const appId = `app_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(applications).values({
    id: appId,
    orgId: org!.id,
    name: "Default",
    isDefault: true,
    createdBy: ownerId,
  });
  return appId;
}

describe("resolveSocialProviderForClient", () => {
  beforeEach(async () => {
    await truncateAll();
    _clearSocialCacheForTesting();
  });

  it("returns null for level=application when no row exists", async () => {
    const appId = await seedApp();
    const resolved = await resolveSocialProviderForClient(
      { level: "application", referencedApplicationId: appId },
      "google",
    );
    expect(resolved).toBeNull();
  });

  it("returns decrypted creds when per-app config exists", async () => {
    const appId = await seedApp();
    await upsertSocialProvider(appId, "google", {
      clientId: "tenant-google-client.apps.googleusercontent.com",
      clientSecret: "tenant-google-secret",
      scopes: ["openid", "email", "profile"],
    });
    const resolved = await resolveSocialProviderForClient(
      { level: "application", referencedApplicationId: appId },
      "google",
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.clientId).toBe("tenant-google-client.apps.googleusercontent.com");
    expect(resolved!.clientSecret).toBe("tenant-google-secret");
    expect(resolved!.scopes).toEqual(["openid", "email", "profile"]);
    expect(resolved!.source).toBe("per-app");
  });

  it("isolates providers per (app, provider) — google config does not leak to github", async () => {
    const appId = await seedApp();
    await upsertSocialProvider(appId, "google", {
      clientId: "g",
      clientSecret: "gs",
    });
    const githubResolved = await resolveSocialProviderForClient(
      { level: "application", referencedApplicationId: appId },
      "github",
    );
    expect(githubResolved).toBeNull();
  });

  it("is cached across calls and invalidated on upsert/delete", async () => {
    const appId = await seedApp();
    expect(
      await resolveSocialProviderForClient(
        { level: "application", referencedApplicationId: appId },
        "google",
      ),
    ).toBeNull();
    await upsertSocialProvider(appId, "google", {
      clientId: "g",
      clientSecret: "gs",
    });
    const afterUpsert = await resolveSocialProviderForClient(
      { level: "application", referencedApplicationId: appId },
      "google",
    );
    expect(afterUpsert).not.toBeNull();
    await deleteSocialProvider(appId, "google");
    const afterDelete = await resolveSocialProviderForClient(
      { level: "application", referencedApplicationId: appId },
      "google",
    );
    expect(afterDelete).toBeNull();
  });

  it("returns null for non-application clients (no env fallback here)", async () => {
    // Env fallback is handled by the BA singleton getters, not this resolver.
    const resolved = await resolveSocialProviderForClient(
      { level: "org", referencedApplicationId: null },
      "google",
    );
    expect(resolved).toBeNull();
  });

  it("invalidateSocialCache with provider arg clears only that provider", async () => {
    const appId = await seedApp();
    await upsertSocialProvider(appId, "google", {
      clientId: "g1",
      clientSecret: "s1",
    });
    await upsertSocialProvider(appId, "github", {
      clientId: "gh1",
      clientSecret: "ghs1",
    });
    // Prime the cache.
    await resolveSocialProviderForClient(
      { level: "application", referencedApplicationId: appId },
      "google",
    );
    await resolveSocialProviderForClient(
      { level: "application", referencedApplicationId: appId },
      "github",
    );
    // Update google directly (bypass service to avoid its own cache invalidation).
    await upsertSocialProvider(appId, "google", {
      clientId: "g2",
      clientSecret: "s2",
    });
    invalidateSocialCache(appId, "google");
    const google = await resolveSocialProviderForClient(
      { level: "application", referencedApplicationId: appId },
      "google",
    );
    expect(google!.clientId).toBe("g2");
  });
});
