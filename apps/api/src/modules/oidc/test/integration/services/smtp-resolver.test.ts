// SPDX-License-Identifier: Apache-2.0

/**
 * Resolver smoke tests — per-space SMTP config.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { encryptCredentials } from "@appstrate/connect";
import { prefixedId } from "@appstrate/db/ids";
import { db } from "@appstrate/db/client";
import { user as userTable, organizations, spaces, spaceSmtpConfigs } from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  resolveSmtpForClient,
  invalidateSmtpCache,
  _clearSmtpCacheForTesting,
  upsertSmtpConfig,
  deleteSmtpConfig,
} from "../../../services/smtp.ts";

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
      name: "SMTP Resolver Test",
      slug: `smtp-${crypto.randomUUID().slice(0, 8)}`,
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

describe("resolveSmtpForClient", () => {
  beforeEach(async () => {
    await truncateAll();
    _clearSmtpCacheForTesting();
  });

  it("returns null for level=space when no config exists", async () => {
    const spaceId = await seedOrgWithSpace();
    const resolved = await resolveSmtpForClient({
      level: "space",
      referencedSpaceId: spaceId,
    });
    expect(resolved).toBeNull();
  });

  it("returns a transport + from metadata when per-space config exists", async () => {
    const spaceId = await seedOrgWithSpace();
    await upsertSmtpConfig(spaceId, {
      host: "__test_json__",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: "noreply@tenant.example",
      fromName: "Tenant",
    });
    const resolved = await resolveSmtpForClient({
      level: "space",
      referencedSpaceId: spaceId,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("per-space");
    expect(resolved!.fromAddress).toBe("noreply@tenant.example");
    expect(resolved!.fromName).toBe("Tenant");
  });

  it("is cached across calls and invalidated on upsert/delete", async () => {
    const spaceId = await seedOrgWithSpace();
    // First call: null, cached.
    expect(await resolveSmtpForClient({ level: "space", referencedSpaceId: spaceId })).toBeNull();
    // Upsert invalidates the cache → next call picks up the row.
    await upsertSmtpConfig(spaceId, {
      host: "__test_json__",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: "noreply@tenant.example",
    });
    const afterUpsert = await resolveSmtpForClient({
      level: "space",
      referencedSpaceId: spaceId,
    });
    expect(afterUpsert).not.toBeNull();
    // Delete invalidates again.
    await deleteSmtpConfig(spaceId);
    const afterDelete = await resolveSmtpForClient({
      level: "space",
      referencedSpaceId: spaceId,
    });
    expect(afterDelete).toBeNull();
  });

  it("treats an unreadable ciphertext as unconfigured, a missing key as a 503", async () => {
    const spaceId = await seedOrgWithSpace();
    const values = {
      spaceId,
      host: "smtp.tenant.example",
      port: 587,
      username: "u",
      passEncrypted: "v1:not-a-real-envelope",
      fromAddress: "noreply@tenant.example",
    };
    await db.insert(spaceSmtpConfigs).values(values);
    const client = { level: "space" as const, referencedSpaceId: spaceId };
    expect(await resolveSmtpForClient(client)).toBeNull();

    // A missing key must not read as "not configured", and must not be cached as such.
    await db
      .update(spaceSmtpConfigs)
      .set({ passEncrypted: `v1:retired-unknown-kid:${Buffer.alloc(64).toString("base64")}` })
      .where(eq(spaceSmtpConfigs.spaceId, spaceId));
    await invalidateSmtpCache(spaceId);
    await expect(resolveSmtpForClient(client)).rejects.toMatchObject({
      status: 503,
      code: "encryption_key_unavailable",
    });

    // The 503 was not cached: once the row reads again, the very next call serves it.
    await db
      .update(spaceSmtpConfigs)
      .set({ host: "__test_json__", passEncrypted: encryptCredentials({ pass: "p" }) })
      .where(eq(spaceSmtpConfigs.spaceId, spaceId));
    expect(await resolveSmtpForClient(client)).not.toBeNull();
  });

  it("level=org / level=instance fall back to env SMTP (null when env absent)", async () => {
    // Test env wipes SMTP vars by default → env SMTP should be null.
    const resolved = await resolveSmtpForClient({
      level: "org",
      referencedSpaceId: null,
    });
    expect(resolved).toBeNull();
  });

  it("invalidateSmtpCache forces a DB re-read", async () => {
    const spaceId = await seedOrgWithSpace();
    await upsertSmtpConfig(spaceId, {
      host: "__test_json__",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: "first@tenant.example",
    });
    const first = await resolveSmtpForClient({
      level: "space",
      referencedSpaceId: spaceId,
    });
    expect(first!.fromAddress).toBe("first@tenant.example");

    // Direct DB update bypassing the service → cache would still have the
    // old row. Manually invalidate to force re-read.
    await upsertSmtpConfig(spaceId, {
      host: "__test_json__",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: "second@tenant.example",
    });
    invalidateSmtpCache(spaceId);
    const second = await resolveSmtpForClient({
      level: "space",
      referencedSpaceId: spaceId,
    });
    expect(second!.fromAddress).toBe("second@tenant.example");
  });
});
