// SPDX-License-Identifier: Apache-2.0

/**
 * `importOAuthModelProviderConnection` — service-level coverage.
 *
 * The CLI does the loopback OAuth dance on the user's machine (since the
 * public CLI client_ids only allowlist `localhost:PORT/...` redirect_uris)
 * and POSTs the resulting tokens to `/api/model-providers-oauth/import`.
 * That route is a thin Zod + audit + permission wrapper around this
 * service function — most of the persistence + claim-derivation logic
 * lives here, so we exercise the function directly.
 *
 * Edge cases under test:
 *   - Happy path Codex: persists row, surfaces availableModelIds.
 *   - Happy path Claude: passes `subscriptionType` + `email` through verbatim.
 *   - Codex JWT defensive decoding extracts `chatgpt_account_id` server-side
 *     even when the request body did not provide it (the CLI sends raw
 *     tokens; the platform doesn't trust client-supplied claims).
 *   - Unknown providerPackageId → 404 (`notFound`).
 *   - Empty label → 400 (`invalidRequest`).
 *   - Missing accessToken/refreshToken → 400.
 *   - Auto-creates a default connection profile when none is provided.
 *   - Re-import on the same provider/profile upserts the connection in place
 *     (no orphan rows).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, and } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedPackage } from "../../helpers/seed.ts";
import { decryptCredentials } from "@appstrate/connect";
import { userProviderConnections, orgSystemProviderKeys } from "@appstrate/db/schema";
import { importOAuthModelProviderConnection } from "../../../src/services/oauth-model-providers/oauth-flow.ts";
import { ApiError } from "../../../src/lib/errors.ts";

const CODEX = "@appstrate/provider-codex";
const CLAUDE = "@appstrate/provider-claude-code";

/**
 * Build a synthetic Codex-shaped JWT (RS256 alg header but unsigned — the
 * platform reads the payload defensively, never verifies the signature, so
 * "x" as fake signature suffices). The payload carries the canonical
 * Codex claims we care about: `chatgpt_account_id` under
 * `https://api.openai.com/auth` and `email`.
 */
function makeFakeCodexJwt(payload: {
  chatgpt_account_id?: string;
  email?: string;
  [k: string]: unknown;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = {
    iss: "https://auth.openai.com",
    aud: "codex-cli",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": payload.chatgpt_account_id
      ? { chatgpt_account_id: payload.chatgpt_account_id }
      : {},
    ...(payload.email ? { email: payload.email } : {}),
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${body}.x`;
}

describe("importOAuthModelProviderConnection", () => {
  let userId: string;
  let orgId: string;
  let applicationId: string;

  beforeEach(async () => {
    await truncateAll();
    const user = await createTestUser();
    userId = user.id;
    const { org, defaultAppId } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    applicationId = defaultAppId;
    // FK target: applicationProviderCredentials.providerId references packages.id.
    // Seed both system providers so the helper's auto-row creation can succeed.
    for (const id of [CODEX, CLAUDE]) {
      await seedPackage({ orgId: null, id, type: "provider", source: "system" }).catch(() => {});
    }
  });

  it("happy path Codex: persists connection + provider key + decodes account_id from JWT", async () => {
    const accessJwt = makeFakeCodexJwt({
      chatgpt_account_id: "acc-123",
      email: "user@example.com",
    });

    const result = await importOAuthModelProviderConnection({
      orgId,
      applicationId,
      userId,
      providerPackageId: CODEX,
      label: "ChatGPT Pro",
      accessToken: accessJwt,
      refreshToken: "rt-codex",
      expiresAt: Date.now() + 3600 * 1000,
    });

    expect(result.providerPackageId).toBe(CODEX);
    expect(result.providerKeyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    // Email recovered from the JWT even though the request body omitted it
    expect(result.email).toBe("user@example.com");
    expect(result.availableModelIds.length).toBeGreaterThan(0);

    const [conn] = await db
      .select()
      .from(userProviderConnections)
      .where(eq(userProviderConnections.id, result.connectionId));
    expect(conn?.needsReconnection).toBe(false);
    expect(conn?.providerId).toBe(CODEX);

    // Server-side defensive decode of chatgpt_account_id is persisted
    const decrypted = decryptCredentials(conn!.credentialsEncrypted) as Record<string, unknown>;
    expect(decrypted.access_token).toBe(accessJwt);
    expect(decrypted.refresh_token).toBe("rt-codex");
    expect(decrypted.chatgpt_account_id).toBe("acc-123");
    expect(decrypted.email).toBe("user@example.com");

    const [key] = await db
      .select()
      .from(orgSystemProviderKeys)
      .where(eq(orgSystemProviderKeys.id, result.providerKeyId));
    expect(key?.label).toBe("ChatGPT Pro");
    expect(key?.authMode).toBe("oauth");
    expect(key?.oauthConnectionId).toBe(result.connectionId);
    expect(key?.providerPackageId).toBe(CODEX);
  });

  it("happy path Claude: passes subscriptionType + email through verbatim", async () => {
    const result = await importOAuthModelProviderConnection({
      orgId,
      applicationId,
      userId,
      providerPackageId: CLAUDE,
      label: "Claude Max",
      accessToken: "sk-ant-oat01-fake",
      refreshToken: "sk-ant-ort01-fake",
      expiresAt: Date.now() + 3600 * 1000,
      subscriptionType: "max",
      email: "user@anthropic-test.com",
    });

    expect(result.providerPackageId).toBe(CLAUDE);
    expect(result.subscriptionType).toBe("max");
    expect(result.email).toBe("user@anthropic-test.com");

    const [conn] = await db
      .select()
      .from(userProviderConnections)
      .where(eq(userProviderConnections.id, result.connectionId));
    const decrypted = decryptCredentials(conn!.credentialsEncrypted) as Record<string, unknown>;
    expect(decrypted.subscription_type).toBe("max");
    expect(decrypted.email).toBe("user@anthropic-test.com");
    expect(decrypted.chatgpt_account_id).toBeUndefined();
  });

  it("unknown providerPackageId → notFound (404)", async () => {
    await expect(
      importOAuthModelProviderConnection({
        orgId,
        applicationId,
        userId,
        providerPackageId: "@example/not-a-real-provider",
        label: "x",
        accessToken: "a",
        refreshToken: "r",
      }),
    ).rejects.toMatchObject({ status: 404 } as Partial<ApiError>);
  });

  it("empty label → invalidRequest (400)", async () => {
    await expect(
      importOAuthModelProviderConnection({
        orgId,
        applicationId,
        userId,
        providerPackageId: CODEX,
        label: "   ",
        accessToken: makeFakeCodexJwt({ chatgpt_account_id: "x" }),
        refreshToken: "rt",
      }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
  });

  it("missing accessToken → invalidRequest (400)", async () => {
    await expect(
      importOAuthModelProviderConnection({
        orgId,
        applicationId,
        userId,
        providerPackageId: CODEX,
        label: "x",
        accessToken: "",
        refreshToken: "rt",
      }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
  });

  it("auto-creates a default connection profile when none is provided", async () => {
    // No seedConnectionProfile() — first invocation should create the default.
    const result = await importOAuthModelProviderConnection({
      orgId,
      applicationId,
      userId,
      providerPackageId: CODEX,
      label: "ChatGPT",
      accessToken: makeFakeCodexJwt({ chatgpt_account_id: "acc-auto" }),
      refreshToken: "rt-auto",
    });

    const [conn] = await db
      .select()
      .from(userProviderConnections)
      .where(eq(userProviderConnections.id, result.connectionId));
    expect(conn?.connectionProfileId).toBeTruthy();
  });

  it("re-import upserts in place (no orphan rows on the same profile/provider)", async () => {
    const profile = await seedConnectionProfile({
      userId,
      name: "Default",
      isDefault: true,
    });

    const first = await importOAuthModelProviderConnection({
      orgId,
      applicationId,
      userId,
      connectionProfileId: profile.id,
      providerPackageId: CLAUDE,
      label: "Claude v1",
      accessToken: "access-v1",
      refreshToken: "refresh-v1",
      expiresAt: Date.now() + 3600 * 1000,
    });

    const second = await importOAuthModelProviderConnection({
      orgId,
      applicationId,
      userId,
      connectionProfileId: profile.id,
      providerPackageId: CLAUDE,
      label: "Claude v2",
      accessToken: "access-v2",
      refreshToken: "refresh-v2",
      expiresAt: Date.now() + 7200 * 1000,
    });

    // Same connection upserted (new credentials), but a NEW provider key row
    // is created each time — that mirrors how the legacy callback behaved
    // and is fine: stale keys can be deleted by the user. Only
    // userProviderConnections has the unique constraint.
    expect(second.connectionId).toBe(first.connectionId);

    const conns = await db
      .select()
      .from(userProviderConnections)
      .where(
        and(
          eq(userProviderConnections.connectionProfileId, profile.id),
          eq(userProviderConnections.providerId, CLAUDE),
        ),
      );
    expect(conns.length).toBe(1);

    const decrypted = decryptCredentials(conns[0]!.credentialsEncrypted) as Record<string, unknown>;
    expect(decrypted.access_token).toBe("access-v2");
    expect(decrypted.refresh_token).toBe("refresh-v2");
  });
});
