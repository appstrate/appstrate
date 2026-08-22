// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0043_documents_scope_strings` — the data half of the #1177
 * permission-resource rename.
 *
 * The migration chain itself is replayed at boot by the tier-0 harness, so a
 * SYNTACTICALLY broken migration already fails every integration test. What
 * that does NOT prove is that the migration does anything: it runs against an
 * empty database, where a WHERE clause that never matches and a WHERE clause
 * that matches everything are indistinguishable.
 *
 * So this test seeds the rows the migration exists for and replays the exact
 * SQL file, twice — once to assert the rewrite, once to assert the rewrite is
 * idempotent (a partially-applied environment must converge, and re-running a
 * data migration must never be destructive).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { apiKeys, applicationSocialProviders } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";

const MIGRATION = new URL(
  "../../../../../packages/db/drizzle/0043_documents_scope_strings.sql",
  import.meta.url,
).pathname;

async function replayMigration(): Promise<void> {
  const source = await Bun.file(MIGRATION).text();
  for (const statement of source.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    await db.execute(sql.raw(trimmed));
  }
}

async function seedKey(ctx: TestContext, name: string, scopes: string[]): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(apiKeys).values({
    id,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    name,
    keyHash: new Bun.CryptoHasher("sha256").update(id).digest("hex"),
    keyPrefix: "ask_testtest",
    scopes,
  });
  return id;
}

async function scopesOf(id: string): Promise<string[]> {
  const [row] = await db.select({ scopes: apiKeys.scopes }).from(apiKeys).where(eq(apiKeys.id, id));
  return [...row!.scopes].sort();
}

describe("migration 0043 — documents:* → files:* in stored scopes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "scope-migration" });
  });

  it("rewrites a stored documents:* scope and leaves its neighbours alone", async () => {
    const legacy = await seedKey(ctx, "pre-1177", [
      "runs:read",
      "documents:read",
      "documents:delete",
    ]);
    const untouched = await seedKey(ctx, "already-canonical", ["runs:read", "files:read"]);

    await replayMigration();

    expect(await scopesOf(legacy)).toEqual(["files:delete", "files:read", "runs:read"]);
    expect(await scopesOf(untouched)).toEqual(["files:read", "runs:read"]);
  });

  it("collapses a row that carries BOTH spellings instead of duplicating", async () => {
    const both = await seedKey(ctx, "both", ["documents:read", "files:read"]);
    await replayMigration();
    expect(await scopesOf(both)).toEqual(["files:read"]);
  });

  it("is idempotent — a second pass changes nothing", async () => {
    const id = await seedKey(ctx, "twice", ["documents:read", "agents:run"]);
    await replayMigration();
    const first = await scopesOf(id);
    await replayMigration();
    expect(await scopesOf(id)).toEqual(first);
    expect(first).toEqual(["agents:run", "files:read"]);
  });

  it("never touches third-party provider scopes", async () => {
    // `application_social_providers.scopes` holds GOOGLE/GITHUB OAuth scopes,
    // not Appstrate permissions. The `documents:` prefix anchor cannot match a
    // Drive scope URL — this asserts that anchoring, so a future generic
    // rewrite cannot quietly sweep them up.
    const googleScopes = [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ];
    await db.insert(applicationSocialProviders).values({
      applicationId: ctx.defaultAppId,
      provider: "google",
      clientId: "client-id",
      clientSecretEncrypted: "cipher",
      scopes: googleScopes,
    });

    await replayMigration();

    const [row] = await db
      .select({ scopes: applicationSocialProviders.scopes })
      .from(applicationSocialProviders)
      .where(eq(applicationSocialProviders.applicationId, ctx.defaultAppId));
    expect(row!.scopes).toEqual(googleScopes);
  });

  it("leaves an empty scope array empty rather than nulling it", async () => {
    const empty = await seedKey(ctx, "empty", []);
    await replayMigration();
    expect(await scopesOf(empty)).toEqual([]);
  });
});
