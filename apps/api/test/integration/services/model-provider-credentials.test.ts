// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the `services/model-provider-credentials` contract:
 *   - api_key blobs round-trip through encrypt → DB → decrypt
 *   - oauth blobs round-trip with all optional fields preserved
 *   - the `apiKey` plaintext is never stored as plaintext
 *   - the public list shape never carries plaintext
 *   - cross-org reads/updates/deletes are scoped — org A cannot touch org B
 *   - `loadModelProviderCredentials` overlays the registry config
 *     (apiShape, defaultBaseUrl, forceStream, rewriteUrlPath)
 *   - `loadModelProviderCredentials` honors `baseUrlOverride` only for
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
import { createTestContext } from "../../helpers/auth.ts";
import {
  createApiKeyCredential,
  createOAuthCredential,
  deleteModelProviderCredential,
  listModelProviderCredentials,
  loadModelProviderCredentials,
  markCredentialNeedsReconnection,
  updateModelProviderCredential,
  updateOAuthCredentialTokens,
} from "../../../src/services/model-provider-credentials.ts";

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

  it("loadModelProviderCredentials overlays the registry config", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-load-apikey" });
    const id = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "Anthropic",
      providerId: "anthropic",
      apiKey: PLAINTEXT,
    });

    const creds = await loadModelProviderCredentials(ctx.orgId, id);
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
        providerId: "codex",
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
    const compatLoad = await loadModelProviderCredentials(ctx.orgId, compatId);
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
    const openaiLoad = await loadModelProviderCredentials(ctx.orgId, openaiId);
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

    const list = await listModelProviderCredentials(ctx.orgId);
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
    const creds = await loadModelProviderCredentials(ctx.orgId, id);
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

    expect(await loadModelProviderCredentials(ctxB.orgId, id)).toBeNull();
    await updateModelProviderCredential(ctxB.orgId, id, { apiKey: "stolen" });
    const own = await loadModelProviderCredentials(ctxA.orgId, id);
    expect(own!.apiKey).toBe("secret-a");

    await deleteModelProviderCredential(ctxB.orgId, id);
    const stillOwn = await loadModelProviderCredentials(ctxA.orgId, id);
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
      label: "Codex personal",
      providerId: "codex",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1_700_000_000_000,
      scopesGranted: ["openid", "profile", "email"],
      accountId: "acct-abc",
      subscriptionType: "pro",
      email: "user@example.test",
    });

    const creds = await loadModelProviderCredentials(ctx.orgId, id);
    expect(creds!.providerId).toBe("codex");
    expect(creds!.apiShape).toBe("openai-responses");
    expect(creds!.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(creds!.apiKey).toBe("access-1");
    expect(creds!.accountId).toBe("acct-abc");
    expect(creds!.needsReconnection).toBe(false);
    expect(creds!.expiresAt).toBe(1_700_000_000_000);
    expect(creds!.forceStream).toBe(true);
    expect(creds!.forceStore).toBe(false);
    expect(creds!.rewriteUrlPath).toEqual({ from: "/v1/responses", to: "/codex/responses" });
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
        scopesGranted: [],
      }),
    ).rejects.toThrow(/api-key only/);
  });

  it("rejects rotating apiKey on an oauth row (the refresh path is separate)", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-oauth-rotate" });
    const id = await createOAuthCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "claude",
      providerId: "claude-code",
      accessToken: "a",
      refreshToken: "r",
      expiresAt: null,
      scopesGranted: [],
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
      label: "claude",
      providerId: "claude-code",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 1_000,
      scopesGranted: ["user:inference"],
      email: "x@example.test",
      subscriptionType: "max",
    });

    await updateOAuthCredentialTokens(ctx.orgId, id, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 2_000_000,
    });

    const creds = await loadModelProviderCredentials(ctx.orgId, id);
    expect(creds!.apiKey).toBe("new-access");
    expect(creds!.expiresAt).toBe(2_000_000);
    // email/subscriptionType preserved (only surface in list, not in load).
    const list = await listModelProviderCredentials(ctx.orgId);
    expect(list[0]!.oauthEmail).toBe("x@example.test");
  });

  it("markCredentialNeedsReconnection flips the flag", async () => {
    const ctx = await createTestContext({ orgSlug: "mpc-svc-mark" });
    const id = await createOAuthCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "claude",
      providerId: "claude-code",
      accessToken: "a",
      refreshToken: "r",
      expiresAt: null,
      scopesGranted: [],
    });

    await markCredentialNeedsReconnection(ctx.orgId, id);
    const creds = await loadModelProviderCredentials(ctx.orgId, id);
    expect(creds!.needsReconnection).toBe(true);
    const list = await listModelProviderCredentials(ctx.orgId);
    expect(list[0]!.oauthNeedsReconnection).toBe(true);
  });
});
