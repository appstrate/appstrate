// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0046_legacy_permission_scope_strings` — the data half of the #1177
 * permission-resource rename, restored after the two migrations that used to
 * carry it were deleted with their numbers.
 *
 * Why it needs a test rather than a replay: the migration chain is replayed at
 * boot by the tier-0 harness, so a SYNTACTICALLY broken migration already fails
 * every integration test. What that does NOT prove is that the migration does
 * anything — it runs against an empty database, where a `WHERE` clause that
 * never matches and one that matches everything are indistinguishable.
 *
 * So this seeds the rows the migration exists for and replays the exact SQL
 * file, twice: once to assert the rewrite, once to assert it is idempotent (a
 * partially-applied environment must converge, and re-running a data migration
 * must never be destructive).
 *
 * The same scope vocabulary is persisted in TWO column shapes — five `text[]`
 * credential columns and two space-delimited `text` ones — and the array-shaped
 * `unnest(...)` pattern cannot reach the second. Both shapes are exercised, as
 * are the negative cases that prove the rewrite is ANCHORED: a third-party
 * provider scope containing the word `documents` must survive untouched.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  apiKeys,
  spaceSocialProviders,
  cliRefreshToken,
  deviceCode,
  integrationConnections,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  packages,
} from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";

const MIGRATION = new URL(
  "../../../../../packages/db/drizzle/0046_legacy_permission_scope_strings.sql",
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

// ─── Shape 1: the five `text[]` credential columns ───────────────────────────

async function seedKey(ctx: TestContext, name: string, scopes: string[]): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(apiKeys).values({
    id,
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    name,
    keyHash: new Bun.CryptoHasher("sha256").update(id).digest("hex"),
    keyPrefix: "ask_testtest",
    scopes,
  });
  return id;
}

async function keyScopesOf(id: string): Promise<string[]> {
  const [row] = await db.select({ scopes: apiKeys.scopes }).from(apiKeys).where(eq(apiKeys.id, id));
  return [...row!.scopes].sort();
}

/**
 * The token/consent rows are FKs onto `oauth_clients.client_id`, so they need a
 * client row to hang off. The client itself is instance-level (no org/space ref)
 * to satisfy the `oauth_clients_level_check` CHECK.
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

async function clientScopesOf(clientId: string): Promise<string[]> {
  const [row] = await db
    .select({ scopes: oauthClient.scopes })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId));
  return [...(row!.scopes ?? [])].sort();
}

async function seedConsent(ctx: TestContext, clientId: string, scopes: string[]): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(oauthConsent).values({ id, clientId, userId: ctx.user.id, scopes });
  return id;
}

async function consentScopesOf(id: string): Promise<string[]> {
  const [row] = await db
    .select({ scopes: oauthConsent.scopes })
    .from(oauthConsent)
    .where(eq(oauthConsent.id, id));
  return [...row!.scopes].sort();
}

async function seedRefreshToken(
  ctx: TestContext,
  clientId: string,
  scopes: string[],
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(oauthRefreshToken).values({
    id,
    token: `rt-${id}`,
    clientId,
    userId: ctx.user.id,
    scopes,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return id;
}

async function refreshScopesOf(id: string): Promise<string[]> {
  const [row] = await db
    .select({ scopes: oauthRefreshToken.scopes })
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.id, id));
  return [...row!.scopes].sort();
}

async function seedAccessToken(
  ctx: TestContext,
  clientId: string,
  scopes: string[],
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(oauthAccessToken).values({
    id,
    token: `at-${id}`,
    clientId,
    userId: ctx.user.id,
    scopes,
    expiresAt: new Date(Date.now() + 900_000),
  });
  return id;
}

async function accessScopesOf(id: string): Promise<string[]> {
  const [row] = await db
    .select({ scopes: oauthAccessToken.scopes })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.id, id));
  return [...row!.scopes].sort();
}

// ─── Shape 2: the two space-delimited `text` scope columns ───────────────────

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

describe("migration 0046 — documents:* → files:* in every stored scope column", () => {
  let ctx: TestContext;
  const CLIENT_ID = "appstrate-scope-migration-test";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "legacy-scope-migration" });
  });

  describe("the five `text[]` credential columns", () => {
    it("rewrites a stored documents:* scope and leaves its neighbours alone", async () => {
      const legacy = await seedKey(ctx, "pre-1177", [
        "runs:read",
        "documents:read",
        "documents:delete",
      ]);
      const untouched = await seedKey(ctx, "already-canonical", ["runs:read", "files:read"]);

      await replayMigration();

      expect(await keyScopesOf(legacy)).toEqual(["files:delete", "files:read", "runs:read"]);
      expect(await keyScopesOf(untouched)).toEqual(["files:read", "runs:read"]);
    });

    it("reaches all four OAuth scope arrays, not just api_keys", async () => {
      await seedOauthClient(CLIENT_ID, ["runs:read", "documents:read"]);
      const consent = await seedConsent(ctx, CLIENT_ID, ["documents:write"]);
      const refresh = await seedRefreshToken(ctx, CLIENT_ID, ["documents:read", "agents:run"]);
      const access = await seedAccessToken(ctx, CLIENT_ID, ["documents:delete"]);

      await replayMigration();

      expect(await clientScopesOf(CLIENT_ID)).toEqual(["files:read", "runs:read"]);
      expect(await consentScopesOf(consent)).toEqual(["files:write"]);
      expect(await refreshScopesOf(refresh)).toEqual(["agents:run", "files:read"]);
      expect(await accessScopesOf(access)).toEqual(["files:delete"]);
    });

    it("collapses a row that carries BOTH spellings instead of duplicating", async () => {
      const both = await seedKey(ctx, "both", ["documents:read", "files:read"]);
      await replayMigration();
      expect(await keyScopesOf(both)).toEqual(["files:read"]);
    });

    it("leaves an empty scope array empty rather than nulling it", async () => {
      const empty = await seedKey(ctx, "empty", []);
      await replayMigration();
      expect(await keyScopesOf(empty)).toEqual([]);
    });

    it("is idempotent — a second pass changes nothing", async () => {
      const id = await seedKey(ctx, "twice", ["documents:read", "agents:run"]);
      await replayMigration();
      const first = await keyScopesOf(id);
      await replayMigration();
      expect(await keyScopesOf(id)).toEqual(first);
      expect(first).toEqual(["agents:run", "files:read"]);
    });
  });

  describe("the two space-delimited `text` scope columns", () => {
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
      // 'documents:%')` never selects it. That proves the guard is anchored and
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
      // under RFC 6749 §3.3 (a scope string is a token SET), documented in the
      // migration header, and asserted here so it stays a decision rather than
      // an accident.
      const id = await seedCliRefreshToken(ctx, CLIENT_ID, " documents:read   runs:read ");
      await replayMigration();
      expect(await cliScopeOf(id)).toBe("files:read runs:read");
    });

    it("leaves a legacy-free value byte-identical (the WHERE guard never fires)", async () => {
      const id = await seedCliRefreshToken(ctx, CLIENT_ID, "runs:read  files:read");
      await replayMigration();
      // Double space preserved: the row was never rewritten, so the
      // normalization the rewrite would apply must not have happened.
      expect(await cliScopeOf(id)).toBe("runs:read  files:read");
    });

    it("collapses a value carrying BOTH spellings instead of duplicating", async () => {
      const id = await seedCliRefreshToken(ctx, CLIENT_ID, "documents:read files:read runs:read");
      await replayMigration();
      expect(await cliScopeOf(id)).toBe("files:read runs:read");
    });

    it("leaves a NULL scope NULL rather than writing an empty string", async () => {
      const cli = await seedCliRefreshToken(ctx, CLIENT_ID, null);
      const dev = await seedDeviceCode(ctx, CLIENT_ID, null);
      await replayMigration();
      expect(await cliScopeOf(cli)).toBeNull();
      expect(await deviceScopeOf(dev)).toBeNull();
    });

    it("is idempotent — a second pass changes nothing", async () => {
      const id = await seedDeviceCode(ctx, CLIENT_ID, "documents:write runs:read");
      await replayMigration();
      const first = await deviceScopeOf(id);
      await replayMigration();
      expect(await deviceScopeOf(id)).toBe(first);
      expect(first).toBe("files:write runs:read");
    });
  });

  describe("third-party provider scopes are out of reach", () => {
    it("never touches space_social_providers.scopes", async () => {
      // These are GOOGLE/GITHUB OAuth scopes, not Appstrate permissions. The
      // `documents:` prefix anchor cannot match a Drive scope URL — this
      // asserts that anchoring, so a future generic rewrite cannot quietly
      // sweep them up.
      const googleScopes = [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/documents.readonly",
      ];
      await db.insert(spaceSocialProviders).values({
        spaceId: ctx.defaultSpaceId,
        provider: "google",
        clientId: "client-id",
        clientSecretEncrypted: "cipher",
        scopes: googleScopes,
      });

      await replayMigration();

      const [row] = await db
        .select({ scopes: spaceSocialProviders.scopes })
        .from(spaceSocialProviders)
        .where(eq(spaceSocialProviders.spaceId, ctx.defaultSpaceId));
      expect(row!.scopes).toEqual(googleScopes);
    });

    it("never touches integration_connections.scopes_granted", async () => {
      // The GRANTED provider scopes of a connected integration, not Appstrate
      // permissions — named in the migration header as deliberately excluded.
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
        spaceId: ctx.defaultSpaceId,
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
});
