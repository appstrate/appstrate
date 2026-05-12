// SPDX-License-Identifier: Apache-2.0

/**
 * `importOAuthModelProviderConnection` — service-level coverage of the
 * platform's generic OAuth import flow. Provider-specific behavior
 * (claim extraction, requiredIdentityClaims gate) is covered by each
 * module's own test suite — e.g. `apps/api/src/modules/codex/test/
 * integration/services/codex-oauth-flow.test.ts`. This file uses the
 * synthetic `test-oauth` provider so removing or swapping a module never
 * breaks core flow coverage.
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
 *   - Happy path: persists row with provided access/refresh tokens.
 *   - Unknown providerId → 404 (`notFound`).
 *   - Api-key provider rejected (only OAuth providers route here).
 *   - Empty label → 400.
 *   - Missing accessToken/refreshToken → 400.
 *   - Re-import creates a fresh row (no upsert).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { decryptCredentials } from "@appstrate/connect";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { importOAuthModelProviderConnection } from "../../../src/services/model-providers/oauth-flow.ts";
import { type OAuthBlob } from "../../../src/services/model-providers/credentials.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";

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

  it("happy path: persists row with token blob", async () => {
    const result = await importOAuthModelProviderConnection({
      orgId,
      userId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Test OAuth",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3600 * 1000,
      email: "user@example.com",
    });

    expect(result.providerId).toBe(TEST_OAUTH_PROVIDER_ID);
    expect(result.credentialId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.availableModelIds.length).toBeGreaterThan(0);

    const [row] = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, result.credentialId));
    expect(row?.providerId).toBe(TEST_OAUTH_PROVIDER_ID);
    expect(row?.label).toBe("Test OAuth");

    const blob = decryptCredentials<OAuthBlob>(row!.credentialsEncrypted);
    expect(blob.kind).toBe("oauth");
    expect(blob.accessToken).toBe("access-1");
    expect(blob.refreshToken).toBe("refresh-1");
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
        providerId: TEST_OAUTH_PROVIDER_ID,
        label: "   ",
        accessToken: "a",
        refreshToken: "r",
      }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
  });

  it("missing accessToken → invalidRequest (400)", async () => {
    await expect(
      importOAuthModelProviderConnection({
        orgId,
        userId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        label: "x",
        accessToken: "",
        refreshToken: "rt",
      }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
  });

  it("re-import creates a fresh row (no upsert across imports)", async () => {
    const first = await importOAuthModelProviderConnection({
      orgId,
      userId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Test v1",
      accessToken: "access-v1",
      refreshToken: "refresh-v1",
      expiresAt: Date.now() + 3600 * 1000,
    });

    const second = await importOAuthModelProviderConnection({
      orgId,
      userId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      label: "Test v2",
      accessToken: "access-v2",
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
