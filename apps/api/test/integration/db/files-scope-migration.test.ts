// SPDX-License-Identifier: Apache-2.0

/**
 * Migrations `0044_documents_scope_strings` + `0045_documents_scope_delimited_strings`
 * — the data half of the #1177 permission-resource rename.
 *
 * The same scope vocabulary is persisted in TWO column shapes: five `text[]`
 * credential columns (0044) and two space-delimited `text` columns (0045 —
 * `cli_refresh_tokens.scope`, `device_codes.scope`, the OAuth `scope` parameter
 * as posted). 0044's array-shaped `unnest(...)` pattern could not reach the
 * second shape, which is why the pass is split in two.
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
import {
  apiKeys,
  applicationSocialProviders,
  cliRefreshToken,
  deviceCode,
  integrationConnections,
  oauthClient,
  packages,
} from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";

const MIGRATION_0044 = new URL(
  "../../../../../packages/db/drizzle/0044_documents_scope_strings.sql",
  import.meta.url,
).pathname;
const MIGRATION_0045 = new URL(
  "../../../../../packages/db/drizzle/0045_documents_scope_delimited_strings.sql",
  import.meta.url,
).pathname;

async function replayFile(path: string): Promise<void> {
  const source = await Bun.file(path).text();
  for (const statement of source.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    await db.execute(sql.raw(trimmed));
  }
}

/** Replay the pair, in chain order — the shape split is an implementation detail. */
async function replayMigration(): Promise<void> {
  await replayFile(MIGRATION_0044);
  await replayFile(MIGRATION_0045);
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

/**
 * `cli_refresh_tokens.scope` / `device_codes.scope` are FKs onto
 * `oauth_clients.client_id`, so 0045's rows need a client row to hang off.
 * The client itself is instance-level (no org/app ref) to satisfy the
 * `oauth_clients_level_check` CHECK.
 */
async function seedOauthClient(clientId: string, scopes: string[]): Promise<void> {
  await db.insert(oauthClient).values({
    id: crypto.randomUUID(),
    clientId,
    redirectUris: ["http://127.0.0.1:1/callback"],
    scopes,
    level: "instance",
  });
}

async function seedCliRefreshToken(
  ctx: TestContext,
  clientId: string,
  scope: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(cliRefreshToken).values({
    id,
    tokenHash: new Bun.CryptoHasher("sha256").update(id).digest("hex"),
    userId: ctx.user.id,
    clientId,
    familyId: crypto.randomUUID(),
    scope,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return id;
}

async function cliScopeOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ scope: cliRefreshToken.scope })
    .from(cliRefreshToken)
    .where(eq(cliRefreshToken.id, id));
  return row!.scope;
}

async function seedDeviceCode(
  ctx: TestContext,
  clientId: string,
  scope: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(deviceCode).values({
    id,
    deviceCode: `dc-${id}`,
    userCode: `uc-${id.slice(0, 8)}`,
    userId: ctx.user.id,
    clientId,
    status: "pending",
    scope,
    expiresAt: new Date(Date.now() + 600_000),
  });
  return id;
}

async function deviceScopeOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ scope: deviceCode.scope })
    .from(deviceCode)
    .where(eq(deviceCode.id, id));
  return row!.scope;
}

describe("migrations 0044+0045 — documents:* → files:* in stored scopes", () => {
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

  // ── 0045: the space-delimited `text` columns 0044's unnest() could not reach ──

  describe("0045 — space-delimited scope strings", () => {
    const CLIENT_ID = "appstrate-cli-test";

    beforeEach(async () => {
      await seedOauthClient(CLIENT_ID, ["runs:read", "documents:read", "documents:write"]);
    });

    it("rewrites cli_refresh_tokens.scope token-wise, preserving order", async () => {
      const id = await seedCliRefreshToken(ctx, CLIENT_ID, "runs:read documents:read agents:run");
      await replayMigration();
      expect(await cliScopeOf(id)).toBe("runs:read files:read agents:run");
    });

    it("rewrites device_codes.scope token-wise, preserving order", async () => {
      const id = await seedDeviceCode(ctx, CLIENT_ID, "documents:read runs:read");
      await replayMigration();
      expect(await deviceScopeOf(id)).toBe("files:read runs:read");
    });

    it("anchors per token — a `documents:` substring inside a token is untouched", async () => {
      // Two rows, because the WHERE guard and the SET are separate hazards and
      // only one row can exercise each.
      //
      // Row 1 carries NO token STARTING with `documents:` — `mydocuments:read`
      // and the URL both merely contain it — so `WHERE EXISTS (… t LIKE
      // 'documents:%')` never selects it. This proves the guard is anchored and
      // says NOTHING about the SET: a bare replace() in the SET would leave
      // this row byte-identical too, by never running.
      const untouched = "mydocuments:read https://example.test/documents:read";
      const guarded = await seedCliRefreshToken(ctx, CLIENT_ID, untouched);
      // Row 2 puts a real `documents:read` BESIDE the same substring bait, so
      // the guard fires and the `CASE … substring(t FROM 11)` actually runs on
      // the value. This is the row that fails if someone simplifies the SET to
      // `replace('documents:', 'files:')` — that rewrite also turns
      // `mydocuments:read` into `myfiles:read`.
      const rewritten = await seedCliRefreshToken(
        ctx,
        CLIENT_ID,
        "documents:read mydocuments:read",
      );
      await replayMigration();
      expect(await cliScopeOf(guarded)).toBe(untouched);
      expect(await cliScopeOf(rewritten)).toBe("files:read mydocuments:read");
    });

    it("normalizes whitespace on a row it DOES rewrite (intentional)", async () => {
      // Sibling of the byte-identical case below, on the other branch. Once the
      // guard fires, `regexp_split_to_table(…, '\\s+')` + `WHERE t <> ''` +
      // `string_agg(…, ' ')` reassemble the value from its tokens: runs of
      // whitespace collapse to one space and the ends are trimmed. Harmless
      // under RFC 6749 §3.3 (a scope string is a token SET), documented in
      // 0045's header, and asserted here so it stays a decision rather than an
      // accident.
      const id = await seedCliRefreshToken(ctx, CLIENT_ID, " documents:read   runs:read ");
      await replayMigration();
      expect(await cliScopeOf(id)).toBe("files:read runs:read");
    });

    it("collapses a value carrying BOTH spellings instead of duplicating", async () => {
      const id = await seedCliRefreshToken(ctx, CLIENT_ID, "documents:read files:read runs:read");
      await replayMigration();
      expect(await cliScopeOf(id)).toBe("files:read runs:read");
    });

    it("is idempotent — a second pass changes nothing", async () => {
      const id = await seedDeviceCode(ctx, CLIENT_ID, "documents:write runs:read");
      await replayMigration();
      const first = await deviceScopeOf(id);
      await replayMigration();
      expect(await deviceScopeOf(id)).toBe(first);
      expect(first).toBe("files:write runs:read");
    });

    it("leaves a NULL scope NULL rather than writing an empty string", async () => {
      const cli = await seedCliRefreshToken(ctx, CLIENT_ID, null);
      const dev = await seedDeviceCode(ctx, CLIENT_ID, null);
      await replayMigration();
      expect(await cliScopeOf(cli)).toBeNull();
      expect(await deviceScopeOf(dev)).toBeNull();
    });

    it("leaves a legacy-free value byte-identical (the WHERE guard never fires)", async () => {
      const id = await seedCliRefreshToken(ctx, CLIENT_ID, "runs:read  files:read");
      await replayMigration();
      // Double space preserved: the row was never rewritten, so the
      // normalization the rewrite would apply must not have happened.
      expect(await cliScopeOf(id)).toBe("runs:read  files:read");
    });
  });

  it("never touches integration_connections.scopes_granted (third-party scopes)", async () => {
    // Sibling of the `application_social_providers` case above: these are the
    // GRANTED provider scopes of a connected integration, not Appstrate
    // permissions. Named in both migration headers as deliberately excluded.
    // `packages.id` is the `@scope/name` package id (CHECK `packages_id_format`).
    const packageId = "@test/scope-migration-integration";
    await db.insert(packages).values({ id: packageId, orgId: ctx.orgId, type: "integration" });
    const granted = ["https://www.googleapis.com/auth/documents.readonly", "documents:read"];
    const connectionId = crypto.randomUUID();
    await db.insert(integrationConnections).values({
      id: connectionId,
      integrationId: packageId,
      authKey: "primary",
      accountId: "acct-1",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      credentialsEncrypted: "cipher",
      scopesGranted: granted,
    });

    await replayMigration();

    const [row] = await db
      .select({ scopesGranted: integrationConnections.scopesGranted })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));
    expect(row!.scopesGranted).toEqual(granted);
  });
});
