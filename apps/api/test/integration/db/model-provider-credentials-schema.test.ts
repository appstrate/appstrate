// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the `model_provider_credentials` table contract:
 *   - insert/select round-trip preserves every column
 *   - both blob shapes (api_key + oauth) are accepted (the column is opaque text)
 *   - org_id FK cascades on org delete — credentials don't outlive their org
 *   - the org_id index makes per-org listing trivially scannable
 *
 * Only the table schema; service-level encryption/decryption is covered in
 * Phase 3 by `services/model-provider-credentials.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials, organizations } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";

describe("model_provider_credentials table schema", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("round-trips an api-key row (canonical providerId)", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-apikey" });
    const [inserted] = await db
      .insert(modelProviderCredentials)
      .values({
        orgId: ctx.orgId,
        label: "OpenAI prod",
        providerId: "openai",
        credentialsEncrypted: "v1:k1:dummy-opaque-blob",
        baseUrlOverride: null,
        createdBy: ctx.user.id,
      })
      .returning();
    expect(inserted!.id).toBeDefined();

    const [row] = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, inserted!.id));
    expect(row!.providerId).toBe("openai");
    expect(row!.label).toBe("OpenAI prod");
    expect(row!.baseUrlOverride).toBeNull();
    expect(row!.credentialsEncrypted).toBe("v1:k1:dummy-opaque-blob");
    expect(row!.createdBy).toBe(ctx.user.id);
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it("round-trips an oauth row with no baseUrlOverride", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-oauth" });
    const [inserted] = await db
      .insert(modelProviderCredentials)
      .values({
        orgId: ctx.orgId,
        label: "Codex personal",
        providerId: "codex",
        credentialsEncrypted: "v1:k1:another-opaque-blob",
        createdBy: ctx.user.id,
      })
      .returning();

    const [row] = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, inserted!.id));
    expect(row!.providerId).toBe("codex");
    expect(row!.baseUrlOverride).toBeNull();
  });

  it("accepts a baseUrlOverride for openai-compatible custom endpoints", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-custom" });
    const [inserted] = await db
      .insert(modelProviderCredentials)
      .values({
        orgId: ctx.orgId,
        label: "Local Ollama",
        providerId: "openai-compatible",
        credentialsEncrypted: "v1:k1:opaque",
        baseUrlOverride: "http://host.docker.internal:11434",
        createdBy: ctx.user.id,
      })
      .returning();

    const [row] = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, inserted!.id));
    expect(row!.baseUrlOverride).toBe("http://host.docker.internal:11434");
  });

  it("cascades on org delete — credentials don't outlive their org", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-cascade" });
    await db.insert(modelProviderCredentials).values({
      orgId: ctx.orgId,
      label: "to be cascaded",
      providerId: "openai",
      credentialsEncrypted: "v1:k1:opaque",
      createdBy: ctx.user.id,
    });

    // Sanity: row exists.
    const before = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.orgId, ctx.orgId));
    expect(before).toHaveLength(1);

    await db.delete(organizations).where(eq(organizations.id, ctx.orgId));

    const after = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.orgId, ctx.orgId));
    expect(after).toHaveLength(0);
  });

  it("supports multiple credentials of the same providerId in one org (e.g. prod + staging keys)", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-multi" });
    await db.insert(modelProviderCredentials).values([
      {
        orgId: ctx.orgId,
        label: "OpenAI prod",
        providerId: "openai",
        credentialsEncrypted: "v1:k1:blob-a",
        createdBy: ctx.user.id,
      },
      {
        orgId: ctx.orgId,
        label: "OpenAI staging",
        providerId: "openai",
        credentialsEncrypted: "v1:k1:blob-b",
        createdBy: ctx.user.id,
      },
    ]);

    const rows = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.orgId, ctx.orgId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.label))).toEqual(new Set(["OpenAI prod", "OpenAI staging"]));
  });
});
