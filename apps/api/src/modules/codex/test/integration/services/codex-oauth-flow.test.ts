// SPDX-License-Identifier: Apache-2.0

/**
 * Codex module — integration coverage for OAuth flow behaviors that depend
 * on this module's `extractTokenIdentity` hook and `requiredIdentityClaims`
 * declaration. Generic flow coverage (unknown providerId, empty label,
 * api-key rejection, refresh, soft-disable, etc.) lives in the core suite
 * under `apps/api/test/integration/` and is exercised against the synthetic
 * `test-oauth` provider — that suite must not depend on this module being
 * loaded.
 *
 * What this file owns:
 *   - JWT decoding round-trip (CLI sends raw access token → platform
 *     extracts `chatgpt_account_id` server-side via the codex hook → row
 *     persists it).
 *   - `requiredIdentityClaims: ["chatgpt_account_id"]` gate fires when
 *     the token has no decodable account id and the CLI didn't forward
 *     one in the body.
 *   - End-to-end `loadInferenceCredentials` returns the decoded account
 *     id (regression for the bug where OAuth rows returned null on read).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateAll, db } from "../../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../../test/helpers/auth.ts";
import { decryptCredentials } from "@appstrate/connect";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { importOAuthModelProviderConnection } from "../../../../../services/model-providers/oauth-flow.ts";
import {
  loadInferenceCredentials,
  listOrgModelProviderCredentials,
  type OAuthBlob,
} from "../../../../../services/model-providers/credentials.ts";
import { ApiError } from "../../../../../lib/errors.ts";

const CODEX = "codex";

/**
 * Build a synthetic Codex-shaped JWT (RS256 alg header but unsigned — the
 * platform reads the payload defensively, never verifies the signature, so
 * "x" as fake signature suffices).
 */
function makeFakeCodexJwt(payload: { chatgpt_account_id?: string; email?: string }): string {
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

describe("codex module — import + identity extraction", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    await truncateAll();
    const user = await createTestUser();
    userId = user.id;
    const { org } = await createTestOrg(userId, { slug: "codex-it" });
    orgId = org.id;
  });

  it("happy path: persists row + decodes chatgpt_account_id from JWT", async () => {
    const accessJwt = makeFakeCodexJwt({
      chatgpt_account_id: "acc-123",
      email: "user@example.com",
    });

    const result = await importOAuthModelProviderConnection({
      orgId,
      userId,
      providerId: CODEX,
      label: "ChatGPT Pro",
      accessToken: accessJwt,
      refreshToken: "rt-codex",
      expiresAt: Date.now() + 3600 * 1000,
    });

    expect(result.providerId).toBe(CODEX);
    expect(result.credentialId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.email).toBe("user@example.com");
    expect(result.availableModelIds.length).toBeGreaterThan(0);

    const [row] = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, result.credentialId));
    expect(row?.providerId).toBe("codex");
    expect(row?.label).toBe("ChatGPT Pro");

    const blob = decryptCredentials<OAuthBlob>(row!.credentialsEncrypted);
    expect(blob.kind).toBe("oauth");
    expect(blob.accessToken).toBe(accessJwt);
    expect(blob.refreshToken).toBe("rt-codex");
    expect(blob.accountId).toBe("acc-123");
    expect(blob.email).toBe("user@example.com");
    expect(blob.needsReconnection).toBe(false);
  });

  it("requiredIdentityClaims gate: rejects token without decodable chatgpt_account_id", async () => {
    const noAccountJwt = makeFakeCodexJwt({ email: "x@example.com" });
    await expect(
      importOAuthModelProviderConnection({
        orgId,
        userId,
        providerId: CODEX,
        label: "ChatGPT",
        accessToken: noAccountJwt,
        refreshToken: "rt",
      }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
  });

  it("aggregator surfaces codex OAuth row with providerId + authMode='oauth2'", async () => {
    const accessJwt = makeFakeCodexJwt({
      chatgpt_account_id: "acc-list-1",
      email: "user@example.com",
    });
    const imported = await importOAuthModelProviderConnection({
      orgId,
      userId,
      providerId: CODEX,
      label: "ChatGPT Pro",
      accessToken: accessJwt,
      refreshToken: "rt-codex",
      expiresAt: Date.now() + 3600 * 1000,
      email: "user@example.com",
    });

    const list = await listOrgModelProviderCredentials(orgId);
    const oauth = list.find((k) => k.id === imported.credentialId);
    expect(oauth).toBeDefined();
    expect(oauth!.source).toBe("custom");
    expect(oauth!.authMode).toBe("oauth2");
    expect(oauth!.providerId).toBe("codex");
    expect(oauth!.oauthEmail).toBe("user@example.com");
    expect(oauth!.needsReconnection).toBe(false);
  });

  it("loadInferenceCredentials returns access token + providerId + accountId for codex", async () => {
    const accessJwt = makeFakeCodexJwt({
      chatgpt_account_id: "acc-codex-123",
      email: "user@example.com",
    });
    const imported = await importOAuthModelProviderConnection({
      orgId,
      userId,
      providerId: CODEX,
      label: "ChatGPT Pro",
      accessToken: accessJwt,
      refreshToken: "rt-codex",
      expiresAt: Date.now() + 3600 * 1000,
    });

    const creds = await loadInferenceCredentials(orgId, imported.credentialId);
    expect(creds).not.toBeNull();
    // OAuth rows must not return null on read (regression).
    expect(creds!.apiKey).toBe(accessJwt);
    // accountId must be propagated through the return shape — a missing
    // field here surfaces as "Missing chatgpt-account-id" downstream when
    // the codex module's `buildInferenceProbe` hook runs.
    expect(creds!.accountId).toBe("acc-codex-123");
    // providerId is what the platform looks up in the registry to find
    // the codex module's hooks (`buildInferenceProbe`, `buildApiKey-
    // Placeholder`, `extractTokenIdentity`).
    expect(creds!.providerId).toBe("codex");
    // Codex uses apiShape "openai-codex-responses" — sidecar resolves
    // `${baseUrl}/codex/responses` natively, no URL rewrite needed.
    expect(creds!.apiShape).toBe("openai-codex-responses");
    expect(creds!.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(creds!.rewriteUrlPath).toBeUndefined();
    expect(creds!.forceStream).toBe(true);
    expect(creds!.forceStore).toBe(false);
  });
});
