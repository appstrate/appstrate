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
 *
 * The service is dormant in production at the time of writing this file —
 * Phase 4 wires it into the OAuth flow and Phase 6 wires it into the routes.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, createTestOrg } from "../../helpers/auth.ts";
import {
  createApiKeyCredential,
  createOAuthCredential,
  deleteModelProviderCredential,
  listOrgModelProviderCredentials,
  loadInferenceCredentials,
  markCredentialNeedsReconnection,
  resolveProviderIdFromApiKeyForm,
  updateModelProviderCredential,
  updateOAuthCredentialTokens,
} from "../../../src/services/model-provider-credentials.ts";
import { importOAuthModelProviderConnection } from "../../../src/services/oauth-model-providers/oauth-flow.ts";

const PLAINTEXT = "sk-test-plaintext-do-not-leak-12345";

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
    expect(openaiLoad!.baseUrl).toBe("https://api.openai.com");
    const [row] = await db
      .select({ baseUrlOverride: modelProviderCredentials.baseUrlOverride })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, openaiId));
    expect(row!.baseUrlOverride).toBeNull();
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

    const list = (await listOrgModelProviderCredentials(ctx.orgId)).filter(
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
    const list = (await listOrgModelProviderCredentials(ctx.orgId)).filter(
      (k) => k.source === "custom",
    );
    expect(list[0]!.oauthEmail).toBe("x@example.test");
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
    const list = (await listOrgModelProviderCredentials(ctx.orgId)).filter(
      (k) => k.source === "custom",
    );
    expect(list[0]!.needsReconnection).toBe(true);
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

  describe("resolveProviderIdFromApiKeyForm", () => {
    it("matches a registered (api, baseUrl) pair to its canonical providerId", () => {
      const r = resolveProviderIdFromApiKeyForm("anthropic-messages", "https://api.anthropic.com");
      expect(r.providerId).toBe("anthropic");
      expect(r.baseUrlOverride).toBeNull();
    });

    it("tolerates a trailing slash on baseUrl", () => {
      const r = resolveProviderIdFromApiKeyForm("anthropic-messages", "https://api.anthropic.com/");
      expect(r.providerId).toBe("anthropic");
    });

    it("falls back to openai-compatible + baseUrlOverride for unknown combos", () => {
      const r = resolveProviderIdFromApiKeyForm(
        "openai-completions",
        "https://self-hosted.example.com/v1",
      );
      expect(r.providerId).toBe("openai-compatible");
      expect(r.baseUrlOverride).toBe("https://self-hosted.example.com/v1");
    });
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

      const list = await listOrgModelProviderCredentials(ctx.orgId);
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

      const list = await listOrgModelProviderCredentials(org.id);
      const oauth = list.find((k) => k.id === imported.credentialId);
      expect(oauth).toBeDefined();
      expect(oauth!.source).toBe("custom");
      expect(oauth!.authMode).toBe("oauth2");
      expect(oauth!.providerId).toBe(TEST_OAUTH);
      expect(oauth!.id).toBe(imported.credentialId);
      expect(oauth!.oauthEmail).toBe("user@example.com");
      expect(oauth!.needsReconnection).toBe(false);
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
      // Provider-specific identity-claim plumbing (e.g. Codex's
      // `chatgpt_account_id` → sidecar header) is covered by each
      // module's own integration tests.
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
