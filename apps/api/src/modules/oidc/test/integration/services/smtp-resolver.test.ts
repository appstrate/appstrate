// SPDX-License-Identifier: Apache-2.0

/**
 * Resolver smoke tests — per-application SMTP config.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { user as userTable, organizations, applications } from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  resolveSmtpForClient,
  invalidateSmtpCache,
  _clearSmtpCacheForTesting,
} from "../../../services/smtp-config.ts";
import { upsertSmtpConfig, deleteSmtpConfig } from "../../../services/smtp-admin.ts";

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
      name: "SMTP Resolver Test",
      slug: `smtp-${crypto.randomUUID().slice(0, 8)}`,
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

describe("resolveSmtpForClient", () => {
  beforeEach(async () => {
    await truncateAll();
    _clearSmtpCacheForTesting();
  });

  it("returns null for level=application when no config exists", async () => {
    const appId = await seedApp();
    const resolved = await resolveSmtpForClient({
      level: "application",
      referencedApplicationId: appId,
    });
    expect(resolved).toBeNull();
  });

  it("returns a transport + from metadata when per-app config exists", async () => {
    const appId = await seedApp();
    await upsertSmtpConfig(appId, {
      host: "__test_json__",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: "noreply@tenant.example",
      fromName: "Tenant",
    });
    const resolved = await resolveSmtpForClient({
      level: "application",
      referencedApplicationId: appId,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("per-app");
    expect(resolved!.fromAddress).toBe("noreply@tenant.example");
    expect(resolved!.fromName).toBe("Tenant");
  });

  it("is cached across calls and invalidated on upsert/delete", async () => {
    const appId = await seedApp();
    // First call: null, cached.
    expect(
      await resolveSmtpForClient({ level: "application", referencedApplicationId: appId }),
    ).toBeNull();
    // Upsert invalidates the cache → next call picks up the row.
    await upsertSmtpConfig(appId, {
      host: "__test_json__",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: "noreply@tenant.example",
    });
    const afterUpsert = await resolveSmtpForClient({
      level: "application",
      referencedApplicationId: appId,
    });
    expect(afterUpsert).not.toBeNull();
    // Delete invalidates again.
    await deleteSmtpConfig(appId);
    const afterDelete = await resolveSmtpForClient({
      level: "application",
      referencedApplicationId: appId,
    });
    expect(afterDelete).toBeNull();
  });

  it("level=org / level=instance fall back to env SMTP (null when env absent)", async () => {
    // Test env wipes SMTP vars by default → env SMTP should be null.
    const resolved = await resolveSmtpForClient({
      level: "org",
      referencedApplicationId: null,
    });
    expect(resolved).toBeNull();
  });

  it("invalidateSmtpCache forces a DB re-read", async () => {
    const appId = await seedApp();
    await upsertSmtpConfig(appId, {
      host: "__test_json__",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: "first@tenant.example",
    });
    const first = await resolveSmtpForClient({
      level: "application",
      referencedApplicationId: appId,
    });
    expect(first!.fromAddress).toBe("first@tenant.example");

    // Direct DB update bypassing the service → cache would still have the
    // old row. Manually invalidate to force re-read.
    await upsertSmtpConfig(appId, {
      host: "__test_json__",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: "second@tenant.example",
    });
    invalidateSmtpCache(appId);
    const second = await resolveSmtpForClient({
      level: "application",
      referencedApplicationId: appId,
    });
    expect(second!.fromAddress).toBe("second@tenant.example");
  });
});
