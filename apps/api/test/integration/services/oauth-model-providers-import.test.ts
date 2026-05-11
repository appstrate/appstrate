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
 * Persistence model (Phase 4+): a single row in `model_provider_credentials`
 * carrying a `kind: "oauth"` blob — no more triple-table dance with
 * `userProviderConnections` + `applicationProviderCredentials`.
 *
 * Edge cases under test:
 *   - Happy path Codex: persists row + decoded chatgpt_account_id.
 *   - Codex JWT defensive decoding extracts `chatgpt_account_id` server-side
 *     even when the request body did not provide it.
 *   - Unknown providerId → 404 (`notFound`).
 *   - Empty label → 400 (`invalidRequest`).
 *   - Missing accessToken/refreshToken → 400.
 *   - Re-import creates a fresh row (the new model does not de-dupe).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { decryptCredentials } from "@appstrate/connect";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { importOAuthModelProviderConnection } from "../../../src/services/oauth-model-providers/oauth-flow.ts";
import { type OAuthBlob } from "../../../src/services/model-provider-credentials.ts";
import { ApiError } from "../../../src/lib/errors.ts";

const CODEX = "codex";

/**
 * Build a synthetic Codex-shaped JWT (RS256 alg header but unsigned — the
 * platform reads the payload defensively, never verifies the signature, so
 * "x" as fake signature suffices).
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

  beforeEach(async () => {
    await truncateAll();
    const user = await createTestUser();
    userId = user.id;
    const { org } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
  });

  it("happy path Codex: persists row + decodes account_id from JWT", async () => {
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

  it("unknown providerId → notFound (404)", async () => {
    await expect(
      importOAuthModelProviderConnection({
        orgId,
        userId,
        providerId: "@example/not-a-real-provider",
        label: "x",
        accessToken: "a",
        refreshToken: "r",
      }),
    ).rejects.toMatchObject({ status: 404 } as Partial<ApiError>);
  });

  it("api-key provider rejected — only OAuth providers route through this flow", async () => {
    await expect(
      importOAuthModelProviderConnection({
        orgId,
        userId,
        providerId: "openai",
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
        userId,
        providerId: CODEX,
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
        userId,
        providerId: CODEX,
        label: "x",
        accessToken: "",
        refreshToken: "rt",
      }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
  });

  it("Codex import without recoverable accountId → invalidRequest (400)", async () => {
    // JWT without the chatgpt_account_id claim, and no body-level accountId.
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

  it("re-import creates a fresh row (no upsert across imports)", async () => {
    const first = await importOAuthModelProviderConnection({
      orgId,
      userId,
      providerId: CODEX,
      label: "Codex v1",
      accessToken: makeFakeCodexJwt({ chatgpt_account_id: "acc-v1" }),
      refreshToken: "refresh-v1",
      expiresAt: Date.now() + 3600 * 1000,
    });

    const second = await importOAuthModelProviderConnection({
      orgId,
      userId,
      providerId: CODEX,
      label: "Codex v2",
      accessToken: makeFakeCodexJwt({ chatgpt_account_id: "acc-v2" }),
      refreshToken: "refresh-v2",
      expiresAt: Date.now() + 7200 * 1000,
    });

    expect(second.credentialId).not.toBe(first.credentialId);

    const rows = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.orgId, orgId));
    expect(rows).toHaveLength(2);
    const blob2 = decryptCredentials<OAuthBlob>(
      rows.find((r) => r.id === second.credentialId)!.credentialsEncrypted,
    );
    expect(blob2.accessToken).toBe("access-v2");
  });
});
