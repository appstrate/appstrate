// SPDX-License-Identifier: Apache-2.0

/**
 * Resolver smoke tests — per-space social auth config.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { prefixedId } from "../../../../../lib/ids.ts";
import { db } from "@appstrate/db/client";
import {
  user as userTable,
  organizations,
  spaces,
  spaceSocialProviders,
} from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  resolveSocialProviderForClient,
  invalidateSocialCache,
  _clearSocialCacheForTesting,
  upsertSocialProvider,
  deleteSocialProvider,
} from "../../../services/social.ts";

/**
 * Seed a throwaway owner + org + space and return the SPACE ID (not the row).
 *
 * Deliberately NOT named `seedSpace`: the shared factory
 * (`test/helpers/seed.ts`) already owns that name with a different signature
 * and return type, and a local shadow of it reads like the shared one at the
 * call site.
 */
async function seedOrgWithSpace(): Promise<string> {
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
  const spaceId = prefixedId("spc");
  await db.insert(spaces).values({
    id: spaceId,
    orgId: org!.id,
    name: "Default",
    isDefault: true,
    createdBy: ownerId,
  });
  return spaceId;
}

describe("resolveSocialProviderForClient", () => {
  beforeEach(async () => {
    await truncateAll();
    _clearSocialCacheForTesting();
  });

  it("returns null for level=space when no row exists", async () => {
    const spaceId = await seedOrgWithSpace();
    const resolved = await resolveSocialProviderForClient(
      { level: "space", referencedSpaceId: spaceId },
      "google",
    );
    expect(resolved).toBeNull();
  });

  it("returns decrypted creds when per-space config exists", async () => {
    const spaceId = await seedOrgWithSpace();
    await upsertSocialProvider(spaceId, "google", {
      clientId: "tenant-google-client.apps.googleusercontent.com",
      clientSecret: "tenant-google-secret",
      scopes: ["openid", "email", "profile"],
    });
    const resolved = await resolveSocialProviderForClient(
      { level: "space", referencedSpaceId: spaceId },
      "google",
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.clientId).toBe("tenant-google-client.apps.googleusercontent.com");
    expect(resolved!.clientSecret).toBe("tenant-google-secret");
    expect(resolved!.scopes).toEqual(["openid", "email", "profile"]);
    expect(resolved!.source).toBe("per-space");
  });

  it("isolates providers per (app, provider) — google config does not leak to github", async () => {
    const spaceId = await seedOrgWithSpace();
    await upsertSocialProvider(spaceId, "google", {
      clientId: "g",
      clientSecret: "gs",
    });
    const githubResolved = await resolveSocialProviderForClient(
      { level: "space", referencedSpaceId: spaceId },
      "github",
    );
    expect(githubResolved).toBeNull();
  });

  it("is cached across calls and invalidated on upsert/delete", async () => {
    const spaceId = await seedOrgWithSpace();
    expect(
      await resolveSocialProviderForClient(
        { level: "space", referencedSpaceId: spaceId },
        "google",
      ),
    ).toBeNull();
    await upsertSocialProvider(spaceId, "google", {
      clientId: "g",
      clientSecret: "gs",
    });
    const afterUpsert = await resolveSocialProviderForClient(
      { level: "space", referencedSpaceId: spaceId },
      "google",
    );
    expect(afterUpsert).not.toBeNull();
    await deleteSocialProvider(spaceId, "google");
    const afterDelete = await resolveSocialProviderForClient(
      { level: "space", referencedSpaceId: spaceId },
      "google",
    );
    expect(afterDelete).toBeNull();
  });

  it("treats a row whose ciphertext cannot be decrypted as unconfigured", async () => {
    const spaceId = await seedOrgWithSpace();
    // Envelope with a kid absent from the keyring — decryption must fail and
    // the resolver must surface "not configured" instead of throwing.
    await db.insert(spaceSocialProviders).values({
      spaceId,
      provider: "google",
      clientId: "tenant-google-client",
      clientSecretEncrypted: `v1:retired-unknown-kid:${Buffer.alloc(64).toString("base64")}`,
    });
    const resolved = await resolveSocialProviderForClient(
      { level: "space", referencedSpaceId: spaceId },
      "google",
    );
    expect(resolved).toBeNull();
  });

  it("returns null for non-space clients (no env fallback here)", async () => {
    // Env fallback is handled by the BA singleton getters, not this resolver.
    const resolved = await resolveSocialProviderForClient(
      { level: "org", referencedSpaceId: null },
      "google",
    );
    expect(resolved).toBeNull();
  });

  it("invalidateSocialCache with provider arg clears only that provider", async () => {
    const spaceId = await seedOrgWithSpace();
    await upsertSocialProvider(spaceId, "google", {
      clientId: "g1",
      clientSecret: "s1",
    });
    await upsertSocialProvider(spaceId, "github", {
      clientId: "gh1",
      clientSecret: "ghs1",
    });
    // Prime the cache.
    await resolveSocialProviderForClient({ level: "space", referencedSpaceId: spaceId }, "google");
    await resolveSocialProviderForClient({ level: "space", referencedSpaceId: spaceId }, "github");
    // Update google directly (bypass service to avoid its own cache invalidation).
    await upsertSocialProvider(spaceId, "google", {
      clientId: "g2",
      clientSecret: "s2",
    });
    invalidateSocialCache(spaceId, "google");
    const google = await resolveSocialProviderForClient(
      { level: "space", referencedSpaceId: spaceId },
      "google",
    );
    expect(google!.clientId).toBe("g2");
  });
});
