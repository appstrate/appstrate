// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the `services/model-provider-credentials` contract:
 *   - api_key blobs round-trip through encrypt → DB → decrypt
 *   - oauth blobs round-trip with all optional fields preserved
 *   - the `apiKey` plaintext is never stored as plaintext
 *   - the public list shape never carries plaintext
 *   - cross-org reads/updates/deletes are scoped — org A cannot touch org B
 *   - `loadInferenceCredentials` overlays the registry config
 *     (apiShape, defaultBaseUrl, forceStream, rewriteUrlPath)
 *   - `loadInferenceCredentials` honors `baseUrlOverride` only for
 *     providers whose registry entry has `baseUrlOverridable: true`
 *   - rotating an api_key re-encrypts and the old blob stops decrypting
 *   - rotating apiKey on an oauth row throws — the OAuth refresh path is
 *     a separate API surface
 *   - `updateOAuthCredentialTokens` writes fresh tokens, preserves email/etc.
 *   - `markCredentialNeedsReconnection` flips the OAuth blob flag
 *   - upstream rejections of an api key flag it within a window; rotation clears it
 *
 * The service is dormant in production at the time of writing this file —
 * Phase 4 wires it into the OAuth flow and Phase 6 wires it into the routes.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  createTestOrg,
  memberContext,
} from "../../helpers/auth.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { updateOrgSettings } from "../../../src/services/organizations.ts";
import {
  assertCredentialEditable,
  canSeeCredential,
  createApiKeyCredential,
  createOAuthCredential,
  deleteModelProviderCredential,
  type ModelCredentialCaller,
  listOrgModelProviderCredentials,
  loadInferenceCredentials,
  markCredentialNeedsReconnection,
  clearModelCredentialRejections,
  recordModelCredentialRejection,
  updateModelProviderCredential,
  updateOAuthCredentialTokens,
} from "../../../src/services/model-providers/credentials.ts";
import { importOAuthModelProviderConnection } from "../../../src/services/model-providers/oauth-flow.ts";
import {
  registerModelProvider,
  resetModelProviders,
} from "../../../src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { corruptCredentialBlob } from "../../helpers/seed.ts";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";

const PLAINTEXT = "sk-test-plaintext-do-not-leak-12345";

/** An org manager's view: every row of the org, and the right to change any of them. */
const adminCaller = (orgId: string): ModelCredentialCaller => ({
  orgId,
  userId: "org-admin",
  readsOrg: true,
  writesOrg: true,
  deletesOrg: true,
});

describe("model-provider-credentials service — api_key path", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("stores an opaque envelope, never the plaintext", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-apikey" });
    const id = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "OpenAI prod",
      providerId: "openai",
      apiKey: PLAINTEXT,
    });

    const [row] = await db
      .select()
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id));
    expect(row!.providerId).toBe("openai");
    expect(JSON.stringify(row)).not.toContain(PLAINTEXT);
    expect(row!.credentialsEncrypted).toMatch(/^v1:[^:]+:[A-Za-z0-9+/=]+$/);
  });

  it("loadInferenceCredentials overlays the registry config", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-load-apikey" });
    const id = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "Anthropic",
      providerId: "anthropic",
      apiKey: PLAINTEXT,
    });

    const creds = await loadInferenceCredentials(ctx.orgId, id);
    expect(creds).not.toBeNull();
    expect(creds!.providerId).toBe("anthropic");
    expect(creds!.apiShape).toBe("anthropic-messages");
    expect(creds!.baseUrl).toBe("https://api.anthropic.com");
    expect(creds!.apiKey).toBe(PLAINTEXT);
    expect(creds!.accountId).toBeUndefined();
    expect(creds!.needsReconnection).toBeUndefined();
  });

  it("rejects an unknown providerId at create time", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-unknown" });
    await expect(
      createApiKeyCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        label: "x",
        providerId: "@unknown/provider",
        apiKey: "x",
      }),
    ).rejects.toThrow(/Unknown providerId/);
  });

  it("rejects createApiKeyCredential for an OAuth provider", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-mismatch" });
    await expect(
      createApiKeyCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        label: "x",
        providerId: "test-oauth",
        apiKey: "x",
      }),
    ).rejects.toThrow(/requires OAuth/);
  });

  it("honors baseUrlOverride only for openai-compatible", async () => {
    // This test pins the prod-strict semantics: only providers declaring
    // `baseUrlOverridable: true` accept a baseUrlOverride. The shared test
    // fixture flips that flag globally for harness convenience, so we
    // restore prod registration just for this case and reseed the baseline
    // afterwards.
    resetModelProviders();
    registerModelProvider({
      providerId: "openai",
      displayName: "OpenAI",
      iconUrl: "openai",
      description: "",
      docsUrl: "",
      apiShape: "openai-responses",
      defaultBaseUrl: "https://api.openai.com/v1",
      baseUrlOverridable: false,
      authMode: "api_key",
      featuredModels: [],
    });
    registerModelProvider({
      providerId: "openai-compatible",
      displayName: "OpenAI-compatible",
      iconUrl: "openai",
      description: "",
      docsUrl: "",
      apiShape: "openai-completions",
      defaultBaseUrl: "http://localhost:11434",
      baseUrlOverridable: true,
      authMode: "api_key",
      featuredModels: [],
    });
    try {
      const ctx = await createTestContext({ orgSlug: "mpc-svc-override" });
      // openai-compatible: override is honored.
      const compatId = await createApiKeyCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        label: "Local Ollama",
        providerId: "openai-compatible",
        apiKey: "ollama-fake-key",
        baseUrlOverride: "http://localhost:11434",
      });
      const compatLoad = await loadInferenceCredentials(ctx.orgId, compatId);
      expect(compatLoad!.baseUrl).toBe("http://localhost:11434");

      // openai: override is silently ignored (not overridable).
      const openaiId = await createApiKeyCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        label: "OpenAI",
        providerId: "openai",
        apiKey: "sk-foo",
        baseUrlOverride: "http://attacker.example/openai",
      });
      const openaiLoad = await loadInferenceCredentials(ctx.orgId, openaiId);
      expect(openaiLoad!.baseUrl).toBe("https://api.openai.com/v1");
      const [row] = await db
        .select({ baseUrlOverride: modelProviderCredentials.baseUrlOverride })
        .from(modelProviderCredentials)
        .where(eq(modelProviderCredentials.id, openaiId));
      expect(row!.baseUrlOverride).toBeNull();
    } finally {
      seedTestModelProviders();
    }
  });

  it("listModelProviderCredentials never exposes plaintext", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-list" });
    await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "OpenAI",
      providerId: "openai",
      apiKey: PLAINTEXT,
    });

    const list = (await listOrgModelProviderCredentials(adminCaller(ctx.orgId))).filter(
      (k) => k.source === "custom",
    );
    expect(list).toHaveLength(1);
    const serialized = JSON.stringify(list[0]);
    expect(serialized).not.toContain(PLAINTEXT);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("credentialsEncrypted");
  });

  it("rotation: updating apiKey re-encrypts; old plaintext stops decrypting", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-rotate" });
    const id = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "rot",
      providerId: "openai",
      apiKey: "old-secret",
    });
    const [before] = await db
      .select({ blob: modelProviderCredentials.credentialsEncrypted })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id));

    await updateModelProviderCredential(ctx.orgId, id, { apiKey: "new-secret" });

    const [after] = await db
      .select({ blob: modelProviderCredentials.credentialsEncrypted })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id));
    expect(after!.blob).not.toBe(before!.blob);
    const creds = await loadInferenceCredentials(ctx.orgId, id);
    expect(creds!.apiKey).toBe("new-secret");
  });

  it("metadata-only update leaves the encrypted blob untouched", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-meta" });
    const id = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "meta",
      providerId: "openai",
      apiKey: "stable-secret",
    });
    const [before] = await db
      .select({ blob: modelProviderCredentials.credentialsEncrypted })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id));

    await updateModelProviderCredential(ctx.orgId, id, { label: "renamed" });

    const [after] = await db
      .select({
        blob: modelProviderCredentials.credentialsEncrypted,
        label: modelProviderCredentials.label,
      })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id));
    expect(after!.blob).toBe(before!.blob);
    expect(after!.label).toBe("renamed");
  });

  it("cross-org isolation — load returns null and update is a silent no-op", async () => {
    const ctxA = await createTestContext({ orgSlug: "mpc-svc-iso-a" });
    const ctxB = await createTestContext({ orgSlug: "mpc-svc-iso-b" });
    const id = await createApiKeyCredential({
      orgId: ctxA.orgId,
      userId: ctxA.user.id,
      label: "a",
      providerId: "openai",
      apiKey: "secret-a",
    });

    expect(await loadInferenceCredentials(ctxB.orgId, id)).toBeNull();
    await updateModelProviderCredential(ctxB.orgId, id, { apiKey: "stolen" });
    const own = await loadInferenceCredentials(ctxA.orgId, id);
    expect(own!.apiKey).toBe("secret-a");

    await deleteModelProviderCredential(ctxB.orgId, id);
    const stillOwn = await loadInferenceCredentials(ctxA.orgId, id);
    expect(stillOwn).not.toBeNull();
  });
});

describe("model-provider-credentials service — oauth path", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("createOAuthCredential round-trips every blob field", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-oauth-create" });
    const id = await createOAuthCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "Test OAuth personal",
      providerId: "test-oauth",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1_700_000_000_000,
      accountId: "acct-abc",
      email: "user@example.test",
    });

    const creds = await loadInferenceCredentials(ctx.orgId, id);
    expect(creds!.providerId).toBe("test-oauth");
    expect(creds!.apiShape).toBe("openai-responses");
    expect(creds!.baseUrl).toBe("https://example.test/v1");
    expect(creds!.apiKey).toBe("access-1");
    expect(creds!.accountId).toBe("acct-abc");
    expect(creds!.needsReconnection).toBe(false);
    expect(creds!.expiresAt).toBe(1_700_000_000_000);
  });

  it("rejects createOAuthCredential for an api-key provider", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-oauth-mismatch" });
    await expect(
      createOAuthCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        label: "x",
        providerId: "openai",
        accessToken: "x",
        refreshToken: "y",
        expiresAt: null,
      }),
    ).rejects.toThrow(/api-key only/);
  });

  it("rejects rotating apiKey on an oauth row (the refresh path is separate)", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-oauth-rotate" });
    const id = await createOAuthCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "test-oauth",
      providerId: "test-oauth",
      accessToken: "a",
      refreshToken: "r",
      expiresAt: null,
    });
    await expect(
      updateModelProviderCredential(ctx.orgId, id, { apiKey: "intruder" }),
    ).rejects.toThrow(/Cannot rotate apiKey/);
  });

  it("updateOAuthCredentialTokens writes fresh tokens and preserves email/account", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-oauth-refresh" });
    const id = await createOAuthCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "test-oauth",
      providerId: "test-oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 1_000,
      email: "x@example.test",
    });

    await updateOAuthCredentialTokens(ctx.orgId, id, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 2_000_000,
    });

    const creds = await loadInferenceCredentials(ctx.orgId, id);
    expect(creds!.apiKey).toBe("new-access");
    expect(creds!.expiresAt).toBe(2_000_000);
    // email preserved (only surface in list, not in load).
    const list = (await listOrgModelProviderCredentials(adminCaller(ctx.orgId))).filter(
      (k) => k.source === "custom",
    );
    expect(list[0]!.oauth_email).toBe("x@example.test");
  });

  it("markCredentialNeedsReconnection flips the flag", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-mark" });
    const id = await createOAuthCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "test-oauth",
      providerId: "test-oauth",
      accessToken: "a",
      refreshToken: "r",
      expiresAt: null,
    });

    await markCredentialNeedsReconnection(ctx.orgId, id);
    // loadInferenceCredentials gates dead OAuth rows — null is the signal.
    expect(await loadInferenceCredentials(ctx.orgId, id)).toBeNull();
    // The list view surfaces the raw flag for UI affordances.
    const list = (await listOrgModelProviderCredentials(adminCaller(ctx.orgId))).filter(
      (k) => k.source === "custom",
    );
    expect(list[0]!.needs_reconnection).toBe(true);
  });
});

describe("model-provider-credentials service — upstream rejections of an api key", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function apiKeyCredential(slug: string) {
    const ctx = await createTestContext({ orgSlug: slug });
    const id = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "OpenAI",
      providerId: "openai",
      apiKey: PLAINTEXT,
    });
    return { orgId: ctx.orgId, id };
  }

  const flagged = async (orgId: string, id: string) =>
    (await listOrgModelProviderCredentials(adminCaller(orgId))).find((k) => k.id === id)!
      .needs_reconnection;

  it("flags the key at INTEGRATION_REFRESH_MAX_FAILURES rejections, and a rotation clears it", async () => {
    const { orgId, id } = await apiKeyCredential("mpc-reject-flag");
    for (let i = 0; i < 4; i++) await recordModelCredentialRejection(orgId, id, PLAINTEXT);
    expect(await flagged(orgId, id)).toBe(false);
    expect(await loadInferenceCredentials(orgId, id)).not.toBeNull();

    await recordModelCredentialRejection(orgId, id, PLAINTEXT);
    expect(await flagged(orgId, id)).toBe(true);
    expect(await loadInferenceCredentials(orgId, id)).toBeNull();

    await updateModelProviderCredential(orgId, id, { apiKey: "sk-rotated" });
    expect(await flagged(orgId, id)).toBe(false);
    expect((await loadInferenceCredentials(orgId, id))!.apiKey).toBe("sk-rotated");
    const [row] = await db
      .select({ count: modelProviderCredentials.refreshFailureCount })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id));
    expect(row!.count).toBe(0);
  });

  it("never flags a key the row no longer holds", async () => {
    const { orgId, id } = await apiKeyCredential("mpc-reject-rotated");
    for (let i = 0; i < 4; i++) await recordModelCredentialRejection(orgId, id, PLAINTEXT);
    await updateModelProviderCredential(orgId, id, { apiKey: "sk-rotated" });
    for (let i = 0; i < 6; i++) await recordModelCredentialRejection(orgId, id, PLAINTEXT);
    expect(await flagged(orgId, id)).toBe(false);
  });

  it("never flags the rotated key when the threshold rejection interleaves with the rotation", async () => {
    const { orgId, id } = await apiKeyCredential("mpc-reject-race");
    for (let round = 0; round < 10; round++) {
      const key = `sk-round-${round}`;
      await updateModelProviderCredential(orgId, id, { apiKey: key });
      for (let i = 0; i < 4; i++) await recordModelCredentialRejection(orgId, id, key);
      const next = `sk-round-${round}-next`;
      await Promise.all([
        recordModelCredentialRejection(orgId, id, key),
        updateModelProviderCredential(orgId, id, { apiKey: next }),
      ]);
      expect((await loadInferenceCredentials(orgId, id))?.apiKey).toBe(next);
      expect(await flagged(orgId, id)).toBe(false);
    }
  });

  it("flags a key rejected on every call, however far apart, at the threshold", async () => {
    const { orgId, id } = await apiKeyCredential("mpc-reject-dead");
    const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
    for (let i = 1; i < max; i++) await recordModelCredentialRejection(orgId, id, PLAINTEXT);
    expect(await flagged(orgId, id)).toBe(false);
    await recordModelCredentialRejection(orgId, id, PLAINTEXT);
    expect(await flagged(orgId, id)).toBe(true);
  });

  it("a successful call ends the streak, so interleaved rejections never flag the key", async () => {
    const { orgId, id } = await apiKeyCredential("mpc-reject-healthy");
    const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
    for (let i = 0; i < 2 * max; i++) {
      await recordModelCredentialRejection(orgId, id, PLAINTEXT);
      await clearModelCredentialRejections(orgId, id);
    }
    expect(await flagged(orgId, id)).toBe(false);
    const [row] = await db
      .select({ count: modelProviderCredentials.refreshFailureCount })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id));
    expect(row!.count).toBe(0);
  });

  it("never flags an OAuth credential", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-reject-oauth" });
    const id = await createOAuthCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "Subscription",
      providerId: "test-oauth",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
    });

    for (let i = 0; i < 6; i++) await recordModelCredentialRejection(ctx.orgId, id, "access-1");
    expect(await flagged(ctx.orgId, id)).toBe(false);
  });
});

/**
 * Aggregator + inference loader — the two pieces of glue that fan
 * (system env-driven keys + DB rows) into a single UI list and a single
 * inference-credential lookup. Both legs must:
 *   - never leak the plaintext apiKey in the list shape
 *   - decrypt successfully for the owning org, return null for any other
 *   - propagate OAuth-only signals (providerId, accountId) through
 *     `loadInferenceCredentials` so the inference path can branch on them
 *   - treat a credential flagged `needsReconnection` as missing
 *
 * The OAuth setup uses `importOAuthModelProviderConnection` rather than
 * hand-building rows so it mirrors the prod control-flow exactly. Past
 * regressions in this path (read returned null for OAuth rows; accountId
 * silently dropped from the return shape) reached production because
 * nothing in the test suite exercised this leg end-to-end.
 */
describe("model-provider-credentials service — aggregator + inference loader", () => {
  const TEST_OAUTH = "test-oauth";

  beforeEach(async () => {
    await truncateAll();
  });

  describe("listOrgModelProviderCredentials (system + DB merge)", () => {
    it("returns custom DB rows tagged source='custom' and never leaks plaintext", async () => {
      const ctx = await createTestContext({ orgSlug: "agg-list-custom" });
      await createApiKeyCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        label: "Anthropic",
        providerId: "anthropic",
        apiKey: PLAINTEXT,
      });

      const list = await listOrgModelProviderCredentials(adminCaller(ctx.orgId));
      const custom = list.filter((k) => k.source === "custom");
      expect(custom).toHaveLength(1);
      // The aggregated UI shape never carries plaintext or the encrypted blob.
      const serialized = JSON.stringify(custom[0]);
      expect(serialized).not.toContain(PLAINTEXT);
      expect(serialized).not.toContain("credentialsEncrypted");
      expect(serialized).not.toContain("apiKey");
      expect(custom[0]!.apiShape).toBe("anthropic-messages");
      expect(custom[0]!.authMode).toBe("api_key");
    });

    it("surfaces OAuth credentials with providerId + authMode='oauth'", async () => {
      const user = await createTestUser();
      const { org } = await createTestOrg(user.id, { slug: "agg-list-oauth" });
      const imported = await importOAuthModelProviderConnection({
        orgId: org.id,
        userId: user.id,
        providerId: TEST_OAUTH,
        label: "Test OAuth",
        accessToken: "access-list-1",
        refreshToken: "refresh-list-1",
        expiresAt: Date.now() + 3600 * 1000,
        email: "user@example.com",
      });

      const list = await listOrgModelProviderCredentials(adminCaller(org.id));
      const oauth = list.find((k) => k.id === imported.credentialId);
      expect(oauth).toBeDefined();
      expect(oauth!.source).toBe("custom");
      expect(oauth!.authMode).toBe("oauth2");
      expect(oauth!.providerId).toBe(TEST_OAUTH);
      expect(oauth!.id).toBe(imported.credentialId);
      expect(oauth!.oauth_email).toBe("user@example.com");
      expect(oauth!.needs_reconnection).toBe(false);
    });

    it("flags a credential whose blob no longer decrypts, in either auth mode", async () => {
      // The models tab badges such a credential's models "unavailable" and
      // sends the user here to reconnect or replace it. Before this, the flag
      // was OAuth-only and read off the decrypted blob — so an undecryptable
      // blob (`blob === null`, hence `isOauth === false`) rendered as a
      // perfectly healthy credential with no Reconnect button.
      const ctx = await createTestContext({ orgSlug: "agg-list-corrupt" });
      const apiKeyId = await createApiKeyCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        label: "OpenAI",
        providerId: "openai",
        apiKey: PLAINTEXT,
      });
      const oauthId = await createOAuthCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        label: "Subscription",
        providerId: TEST_OAUTH,
        accessToken: "a",
        refreshToken: "r",
        expiresAt: null,
      });
      await corruptCredentialBlob(apiKeyId);
      await corruptCredentialBlob(oauthId);

      const list = await listOrgModelProviderCredentials(adminCaller(ctx.orgId));
      expect(list.find((k) => k.id === apiKeyId)!.needs_reconnection).toBe(true);
      const oauth = list.find((k) => k.id === oauthId)!;
      expect(oauth.needs_reconnection).toBe(true);
      // `authMode` comes from the registry, not the blob, so the Reconnect
      // button (gated on authMode === "oauth2" && needs_reconnection) shows.
      expect(oauth.authMode).toBe("oauth2");
      // Same verdict as the inference path, which is what the model list flags on.
      expect(await loadInferenceCredentials(ctx.orgId, apiKeyId)).toBeNull();
      expect(await loadInferenceCredentials(ctx.orgId, oauthId)).toBeNull();
    });

    it("shows a credential under a missing kid as it is, 503s inference, and rotates its key", async () => {
      // A missing key is the operator's to restore: no "reconnect" badge, but no secret either.
      const ctx = await createTestContext({ orgSlug: "agg-list-missing-kid" });
      const apiKeyId = await createApiKeyCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        label: "OpenAI",
        providerId: "openai",
        apiKey: PLAINTEXT,
      });
      await db
        .update(modelProviderCredentials)
        .set({ credentialsEncrypted: `v1:k0gone:${Buffer.alloc(40).toString("base64")}` })
        .where(eq(modelProviderCredentials.id, apiKeyId));

      const listed = (await listOrgModelProviderCredentials(adminCaller(ctx.orgId))).find(
        (k) => k.id === apiKeyId,
      );
      expect(listed!.needs_reconnection).toBe(false);
      await expect(loadInferenceCredentials(ctx.orgId, apiKeyId)).rejects.toMatchObject({
        status: 503,
        code: "encryption_key_unavailable",
      });
      // The repair gesture never reads the old blob.
      await updateModelProviderCredential(ctx.orgId, apiKeyId, { apiKey: "sk-rotated" });
      expect((await loadInferenceCredentials(ctx.orgId, apiKeyId))!.apiKey).toBe("sk-rotated");
    });
  });

  describe("loadInferenceCredentials — DB path (api_key + OAuth)", () => {
    it("returns plaintext only for the owning org (cross-org isolation)", async () => {
      const ctxA = await createTestContext({ orgSlug: "agg-load-iso-a" });
      const ctxB = await createTestContext({ orgSlug: "agg-load-iso-b" });
      const idA = await createApiKeyCredential({
        orgId: ctxA.orgId,
        userId: ctxA.user.id,
        label: "A",
        providerId: "anthropic",
        apiKey: "secret-a",
      });

      const leaked = await loadInferenceCredentials(ctxB.orgId, idA);
      expect(leaked).toBeNull();

      const own = await loadInferenceCredentials(ctxA.orgId, idA);
      expect(own?.apiKey).toBe("secret-a");
      expect(own?.apiShape).toBe("anthropic-messages");
      expect(own?.baseUrl).toBe("https://api.anthropic.com");
    });

    it("returns access token + providerId for OAuth rows (regression: no null on read)", async () => {
      const user = await createTestUser();
      const { org } = await createTestOrg(user.id, { slug: "agg-load-oauth" });
      const imported = await importOAuthModelProviderConnection({
        orgId: org.id,
        userId: user.id,
        providerId: TEST_OAUTH,
        label: "Test OAuth",
        accessToken: "access-load",
        refreshToken: "refresh-load",
        expiresAt: Date.now() + 3600 * 1000,
      });

      const creds = await loadInferenceCredentials(org.id, imported.credentialId);
      expect(creds).not.toBeNull();
      // Regression guard: OAuth rows must not return null on read.
      expect(creds!.apiKey).toBe("access-load");
      // providerId is what the inference probe branches on to apply
      // provider-specific request shaping.
      expect(creds!.providerId).toBe(TEST_OAUTH);
      // Provider-specific identity-claim plumbing (e.g. JWT claim →
      // sidecar header) is covered by each module's own integration tests.
    });

    it("returns null when the underlying OAuth credential is flagged needsReconnection", async () => {
      const user = await createTestUser();
      const { org } = await createTestOrg(user.id, { slug: "agg-load-revoked" });
      const imported = await importOAuthModelProviderConnection({
        orgId: org.id,
        userId: user.id,
        providerId: TEST_OAUTH,
        label: "Test OAuth (about to revoke)",
        accessToken: "access-revoke",
        refreshToken: "refresh-revoke",
        expiresAt: Date.now() + 3600 * 1000,
      });

      // Simulate the refresh worker flagging the credential after a
      // 400 invalid_grant from the upstream provider.
      await markCredentialNeedsReconnection(org.id, imported.credentialId);

      // The loader returns null when the OAuth blob's needsReconnection flag
      // is set, so callers fall through to their own "credential unusable"
      // handling (route returns 404).
      const creds = await loadInferenceCredentials(org.id, imported.credentialId);
      expect(creds).toBeNull();
    });

    it("returns null for an unknown id", async () => {
      const ctx = await createTestContext({ orgSlug: "agg-load-missing" });
      const creds = await loadInferenceCredentials(
        ctx.orgId,
        "00000000-0000-0000-0000-000000000000",
      );
      expect(creds).toBeNull();
    });
  });
});

/**
 * Model-alias leak hardening (#727, Threat A): a BUILT-IN credential
 * (`SYSTEM_PROVIDER_KEYS`) whose every backing model is an alias must hide its
 * binding (`apiShape`/`baseUrl`) in the aggregated list — exposing the endpoint
 * host would reveal the hidden provider to an org admin who can read
 * credentials but never configured the env key. A built-in key backing any
 * non-aliased model keeps its binding (that model exposes it anyway). Custom
 * credentials are out of scope — the admin configured the binding themselves.
 */
describe("listOrgModelProviderCredentials — built-in alias-only binding mask", () => {
  beforeEach(async () => {
    await truncateAll();
    seedTestModelProviders();
  });

  // Restore an empty system-keys state so later files in the same process
  // aren't poisoned (this suite mutates the module-static registry).
  afterEach(() => {
    initSystemModelProviderKeys([]);
  });

  it("nulls apiShape/baseUrl for a built-in key whose models are ALL aliases", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-alias-only" });
    initSystemModelProviderKeys([
      {
        id: "sys-alias-only",
        providerId: "anthropic",
        apiKey: "sk-ant-secret",
        models: [
          { id: "appstrate-medium", modelId: "claude-sonnet-4-6", label: "Medium", aliased: true },
          { id: "appstrate-large", modelId: "claude-opus-4-8", label: "Large", aliased: true },
        ],
      },
    ]);

    const list = await listOrgModelProviderCredentials(adminCaller(ctx.orgId));
    const entry = list.find((c) => c.id === "sys-alias-only");
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("built-in");
    expect(entry!.apiShape).toBeNull();
    expect(entry!.base_url).toBeNull();
    // The label is masked too, and asserting it POSITIVELY is what makes this
    // case discriminate: dropping the mask yields the provider display name
    // ("Anthropic"), which contains none of the lowercase substrings below.
    expect(entry!.label).toBe("System models");
    // The backing host/model id must not appear anywhere in the serialized
    // view — including the vendor name in its display casing.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("Anthropic");
    expect(serialized).not.toContain("anthropic.com");
    expect(serialized).not.toContain("anthropic-messages");
    expect(serialized).not.toContain("claude-");
  });

  it("keeps apiShape/baseUrl for a built-in key backing any non-aliased model", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-mixed" });
    initSystemModelProviderKeys([
      {
        id: "sys-mixed",
        providerId: "anthropic",
        apiKey: "sk-ant-secret",
        models: [
          { id: "appstrate-medium", modelId: "claude-sonnet-4-6", label: "Medium", aliased: true },
          // A plain, non-aliased model under the same key — its binding is
          // visible via /api/models anyway, so the credential stays unmasked.
          { id: "plain-haiku", modelId: "claude-haiku-4-5", aliased: false },
        ],
      },
    ]);

    const list = await listOrgModelProviderCredentials(adminCaller(ctx.orgId));
    const entry = list.find((c) => c.id === "sys-mixed");
    expect(entry).toBeDefined();
    expect(entry!.apiShape).toBe("anthropic-messages");
    expect(entry!.base_url).toBe("https://api.anthropic.com");
  });
});

describe("model-provider-credentials service — visibility and the personal-credential policy", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("canSeeCredential: an org credential needs readsOrg, a personal one its owner alone", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-visible" });
    const member = await memberContext(ctx, "member");
    const reader = await memberContext(ctx, "member");
    const orgCredentialId = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "Org key",
      providerId: "test-apikey",
      apiKey: "sk-org",
    });
    const personalId = await createOAuthCredential({
      orgId: ctx.orgId,
      userId: member.user.id,
      label: "Member subscription",
      providerId: "test-oauth",
      accessToken: "at-member",
      refreshToken: "rt-member",
    });
    const memberCaller: ModelCredentialCaller = {
      orgId: ctx.orgId,
      userId: member.user.id,
      readsOrg: false,
      writesOrg: false,
      deletesOrg: false,
    };
    const readerCaller: ModelCredentialCaller = {
      ...memberCaller,
      userId: reader.user.id,
      readsOrg: true,
    };

    expect(await canSeeCredential(memberCaller, orgCredentialId)).toBe(false);
    expect(await canSeeCredential(readerCaller, orgCredentialId)).toBe(true);
    expect(await canSeeCredential(memberCaller, personalId)).toBe(true);
    expect(await canSeeCredential(readerCaller, personalId)).toBe(false);
    expect(await canSeeCredential(memberCaller, crypto.randomUUID())).toBe(false);

    const otherOrg = await createTestContext({ orgSlug: "mpc-svc-visible-b" });
    expect(await canSeeCredential({ ...readerCaller, orgId: otherOrg.orgId }, personalId)).toBe(
      false,
    );
  });

  it("assertCredentialEditable: deleting takes delete, editing takes write, on org and member rows", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-editable" });
    const member = await memberContext(ctx, "member");
    const orgCredentialId = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "Org key",
      providerId: "test-apikey",
      apiKey: "sk-org",
    });
    const personalId = await createOAuthCredential({
      orgId: ctx.orgId,
      userId: member.user.id,
      label: "Member subscription",
      providerId: "test-oauth",
      accessToken: "at-member",
      refreshToken: "rt-member",
    });
    const base: ModelCredentialCaller = {
      orgId: ctx.orgId,
      userId: ctx.user.id,
      readsOrg: true,
      writesOrg: false,
      deletesOrg: false,
    };
    const writer = { ...base, writesOrg: true };
    const deleter = { ...base, deletesOrg: true };
    const refused = (caller: ModelCredentialCaller, id: string, action: "edit" | "delete") =>
      assertCredentialEditable(caller, id, action).then(
        () => false,
        (err: unknown) => err instanceof ApiError && err.status === 404,
      );

    expect(await refused(writer, orgCredentialId, "edit")).toBe(false);
    expect(await refused(writer, orgCredentialId, "delete")).toBe(true);
    expect(await refused(deleter, orgCredentialId, "delete")).toBe(false);
    expect(await refused(deleter, orgCredentialId, "edit")).toBe(true);
    // Break-glass on a member's own credential: delete only, and only with `delete`.
    expect(await refused(writer, personalId, "delete")).toBe(true);
    expect(await refused(deleter, personalId, "delete")).toBe(false);
    expect(await refused(deleter, personalId, "edit")).toBe(true);
  });

  it("createOAuthCredential refuses a subscription while the org policy is off", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-policy" });
    await updateOrgSettings(ctx.orgId, { personal_model_credentials: false });

    const error = await createOAuthCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "Refused",
      providerId: "test-oauth",
      accessToken: "at",
      refreshToken: "rt",
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("personal_model_credentials_disabled");
    expect((error as ApiError).status).toBe(403);
    expect(await db.select().from(modelProviderCredentials)).toHaveLength(0);
  });
});

describe("model-provider-credentials service — membership lock on creation", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("refuses a personal API-key credential owned by a non-member, and admits a member's", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-lock-key" });
    const member = await memberContext(ctx, "member");
    const outsider = await createTestUser();
    // A personal credential may not pick its endpoint: the provider must not be overridable.
    resetModelProviders();
    registerModelProvider({
      providerId: "personal-fixed-key",
      displayName: "Fixed key",
      iconUrl: "openai",
      description: "",
      docsUrl: "",
      apiShape: "openai-completions",
      defaultBaseUrl: "https://fixed.example.test/v1",
      baseUrlOverridable: false,
      authMode: "api_key",
      featuredModels: [],
    });
    try {
      const createFor = (userId: string) =>
        createApiKeyCredential({
          orgId: ctx.orgId,
          userId,
          ownerUserId: userId,
          label: "Mine",
          providerId: "personal-fixed-key",
          apiKey: "sk-personal",
        });

      const error = await createFor(outsider.id).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(403);
      expect(
        await db
          .select()
          .from(modelProviderCredentials)
          .where(eq(modelProviderCredentials.ownerUserId, outsider.id)),
      ).toHaveLength(0);

      // Control: the same call for a member of the org succeeds.
      expect(await createFor(member.user.id)).toEqual(expect.any(String));
    } finally {
      seedTestModelProviders();
    }
  });

  it("refuses a subscription owned by a non-member, and admits a member's", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-lock-oauth" });
    const member = await memberContext(ctx, "member");
    const outsider = await createTestUser();
    const createFor = (userId: string) =>
      createOAuthCredential({
        orgId: ctx.orgId,
        userId,
        label: "Subscription",
        providerId: "test-oauth",
        accessToken: "at",
        refreshToken: "rt",
      });

    const error = await createFor(outsider.id).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(
      await db
        .select()
        .from(modelProviderCredentials)
        .where(eq(modelProviderCredentials.ownerUserId, outsider.id)),
    ).toHaveLength(0);

    // Control: the same call for a member of the org succeeds.
    expect(await createFor(member.user.id)).toEqual(expect.any(String));
  });
});
