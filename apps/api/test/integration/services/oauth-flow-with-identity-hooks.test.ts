// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-cutting integration coverage for the platform×module OAuth contract
 * when a provider declares an `extractTokenIdentity` hook +
 * `requiredIdentityClaims`. Driven against the synthetic `test-oauth-hooks`
 * provider registered by the test preload — core knows nothing about the
 * specific module-owned providers (codex / claude-code) and the test must
 * not either, so removing any concrete provider module stays a no-op for
 * this file.
 *
 * What this file owns (contracts the platform makes to any hook-bearing
 * module):
 *
 *   1. `importOAuthModelProviderConnection` calls `extractTokenIdentity`
 *      on the bearer token and persists the returned identity slots
 *      (`accountId`, `email`) onto the encrypted credential blob.
 *   2. `requiredIdentityClaims` gates the import — when the hook returns
 *      no value for a required slot AND the CLI didn't forward one in the
 *      body, the platform rejects with 400.
 *   3. `loadInferenceCredentials` returns the persisted identity slots
 *      alongside `providerId`, `apiShape`, `baseUrl`, `forceStream`, and
 *      `forceStore` — exactly what the sidecar / proxy needs without
 *      having to re-resolve the provider definition on the hot path.
 *
 * Each module that registers an `extractTokenIdentity` hook also ships
 * its own unit test for the hook's claim-vocabulary mapping (e.g. the
 * codex module decodes `chatgpt_account_id` from a JWT); those tests live
 * in the module's repo, not here.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import {
  TEST_OAUTH_HOOKS_PROVIDER_ID,
  TEST_OAUTH_HOOKS_BASE_URL,
  TEST_OAUTH_HOOKS_API_SHAPE,
  mintTestOAuthHooksToken,
} from "../../helpers/test-oauth-provider.ts";
import { decryptCredentials } from "@appstrate/connect";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { importOAuthModelProviderConnection } from "../../../src/services/model-providers/oauth-flow.ts";
import {
  loadInferenceCredentials,
  listOrgModelProviderCredentials,
  type OAuthBlob,
} from "../../../src/services/model-providers/credentials.ts";
import { ApiError } from "../../../src/lib/errors.ts";

describe("OAuth flow — extractTokenIdentity + requiredIdentityClaims contract", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    await truncateAll();
    const user = await createTestUser();
    userId = user.id;
    const { org } = await createTestOrg(userId, { slug: "oauth-hooks-it" });
    orgId = org.id;
  });

  it("happy path: persists row + decodes identity claims via extractTokenIdentity hook", async () => {
    const accessToken = mintTestOAuthHooksToken({
      accountId: "acc-123",
      email: "user@example.com",
    });

    const result = await importOAuthModelProviderConnection({
      orgId,
      userId,
      providerId: TEST_OAUTH_HOOKS_PROVIDER_ID,
      label: "Test subscription",
      accessToken,
      refreshToken: "rt-hooks",
      expiresAt: Date.now() + 3600 * 1000,
    });

    expect(result.providerId).toBe(TEST_OAUTH_HOOKS_PROVIDER_ID);
    expect(result.credentialId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.email).toBe("user@example.com");
    expect(result.availableModelIds.length).toBeGreaterThan(0);

    const [row] = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, result.credentialId));
    expect(row?.providerId).toBe(TEST_OAUTH_HOOKS_PROVIDER_ID);
    expect(row?.label).toBe("Test subscription");

    const blob = decryptCredentials<OAuthBlob>(row!.credentialsEncrypted);
    expect(blob.kind).toBe("oauth");
    expect(blob.accessToken).toBe(accessToken);
    expect(blob.refreshToken).toBe("rt-hooks");
    expect(blob.accountId).toBe("acc-123");
    expect(blob.email).toBe("user@example.com");
    expect(blob.needsReconnection).toBe(false);
  });

  it("requiredIdentityClaims gate: rejects token whose hook can't surface the required slot", async () => {
    // Token carries only `email` — provider requires `accountId`.
    const tokenWithoutAccountId = mintTestOAuthHooksToken({ email: "x@example.com" });
    await expect(
      importOAuthModelProviderConnection({
        orgId,
        userId,
        providerId: TEST_OAUTH_HOOKS_PROVIDER_ID,
        label: "Test",
        accessToken: tokenWithoutAccountId,
        refreshToken: "rt",
      }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
  });

  it("aggregator surfaces hook-decorated rows with providerId + authMode='oauth2'", async () => {
    const accessToken = mintTestOAuthHooksToken({
      accountId: "acc-list-1",
      email: "user@example.com",
    });
    const imported = await importOAuthModelProviderConnection({
      orgId,
      userId,
      providerId: TEST_OAUTH_HOOKS_PROVIDER_ID,
      label: "Test subscription",
      accessToken,
      refreshToken: "rt-hooks",
      expiresAt: Date.now() + 3600 * 1000,
      email: "user@example.com",
    });

    const list = await listOrgModelProviderCredentials(orgId);
    const oauth = list.find((k) => k.id === imported.credentialId);
    expect(oauth).toBeDefined();
    expect(oauth!.source).toBe("custom");
    expect(oauth!.authMode).toBe("oauth2");
    expect(oauth!.providerId).toBe(TEST_OAUTH_HOOKS_PROVIDER_ID);
    expect(oauth!.oauthEmail).toBe("user@example.com");
    expect(oauth!.needsReconnection).toBe(false);
  });

  it("loadInferenceCredentials returns access token + providerId + accountId + apiShape", async () => {
    const accessToken = mintTestOAuthHooksToken({
      accountId: "acc-load-123",
      email: "user@example.com",
    });
    const imported = await importOAuthModelProviderConnection({
      orgId,
      userId,
      providerId: TEST_OAUTH_HOOKS_PROVIDER_ID,
      label: "Test subscription",
      accessToken,
      refreshToken: "rt-hooks",
      expiresAt: Date.now() + 3600 * 1000,
    });

    const creds = await loadInferenceCredentials(orgId, imported.credentialId);
    expect(creds).not.toBeNull();
    // OAuth rows must not return null on read (regression).
    expect(creds!.apiKey).toBe(accessToken);
    // Identity slots populated by the hook must flow through the read path
    // so downstream hooks (`buildInferenceProbe`, …) see them.
    expect(creds!.accountId).toBe("acc-load-123");
    // providerId is what the platform looks up in the registry to find
    // the module's hooks (`buildInferenceProbe`, `buildApiKeyPlaceholder`,
    // `extractTokenIdentity`).
    expect(creds!.providerId).toBe(TEST_OAUTH_HOOKS_PROVIDER_ID);
    // apiShape + baseUrl + force* are sidecar resolution inputs — they
    // must propagate through `loadInferenceCredentials` so the proxy
    // doesn't need to re-walk the registry on the hot path.
    expect(creds!.apiShape).toBe(TEST_OAUTH_HOOKS_API_SHAPE);
    expect(creds!.baseUrl).toBe(TEST_OAUTH_HOOKS_BASE_URL);
    expect(creds!.rewriteUrlPath).toBeUndefined();
    expect(creds!.forceStream).toBe(true);
    expect(creds!.forceStore).toBe(false);
  });
});
