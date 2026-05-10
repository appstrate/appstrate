// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `services/org-model-provider-keys` — the org-scoped
 * LLM API key vault. Pins the security-critical contract:
 *
 *   - the `apiKey` plaintext is never returned outside `loadModelProviderKeyCredentials`
 *   - the row's `apiKeyEncrypted` column is opaque (versioned envelope, never plaintext)
 *   - cross-org reads / updates / deletes are scoped — org A cannot touch org B's row
 *   - decryption round-trips for the org that owns the key
 *   - update with a new `apiKey` re-encrypts and the old plaintext stops decrypting
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { orgSystemProviderKeys } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, createTestOrg } from "../../helpers/auth.ts";
import {
  createOrgModelProviderKey,
  deleteOrgModelProviderKey,
  listOrgModelProviderKeys,
  loadModelProviderKeyCredentials,
  updateOrgModelProviderKey,
} from "../../../src/services/org-model-provider-keys.ts";
import { importOAuthModelProviderConnection } from "../../../src/services/oauth-model-providers/oauth-flow.ts";
import { markCredentialNeedsReconnection } from "../../../src/services/model-provider-credentials.ts";

const PLAINTEXT = "sk-test-plaintext-do-not-leak-12345";

const CODEX = "@appstrate/provider-codex";
const CLAUDE = "@appstrate/provider-claude-code";

/**
 * Build a synthetic Codex-shaped JWT carrying a `chatgpt_account_id` claim.
 * Mirrors `oauth-model-providers-import.test.ts` — the platform decodes the
 * payload defensively without verifying the signature, so an unsigned token
 * is sufficient for tests that exercise the read path.
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

describe("org-model-provider-keys service", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  describe("createOrgModelProviderKey", () => {
    it("stores an opaque envelope, never the plaintext, in apiKeyEncrypted", async () => {
      const ctx = await createTestContext({ orgSlug: "vault-create" });
      const id = await createOrgModelProviderKey(
        ctx.orgId,
        "Anthropic",
        "anthropic-messages",
        "https://api.anthropic.com",
        PLAINTEXT,
        ctx.user.id,
      );

      const [row] = await db
        .select()
        .from(orgSystemProviderKeys)
        .where(eq(orgSystemProviderKeys.id, id));
      expect(row).toBeDefined();
      // Plaintext must not appear anywhere in the row.
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(PLAINTEXT);
      // Envelope shape: v1:<kid>:<base64>.
      expect(row!.apiKeyEncrypted).toMatch(/^v1:[^:]+:[A-Za-z0-9+/=]+$/);
    });

    it("returns plaintext only via loadModelProviderKeyCredentials for the owning org", async () => {
      const ctx = await createTestContext({ orgSlug: "vault-load" });
      const id = await createOrgModelProviderKey(
        ctx.orgId,
        "Anthropic",
        "anthropic-messages",
        "https://api.anthropic.com",
        PLAINTEXT,
        ctx.user.id,
      );

      const creds = await loadModelProviderKeyCredentials(ctx.orgId, id);
      expect(creds).not.toBeNull();
      expect(creds!.apiKey).toBe(PLAINTEXT);
      expect(creds!.api).toBe("anthropic-messages");
      expect(creds!.baseUrl).toBe("https://api.anthropic.com");
    });
  });

  describe("listOrgModelProviderKeys", () => {
    it("never exposes the encrypted blob in the public list response", async () => {
      const ctx = await createTestContext({ orgSlug: "vault-list" });
      await createOrgModelProviderKey(
        ctx.orgId,
        "Anthropic",
        "anthropic-messages",
        "https://api.anthropic.com",
        PLAINTEXT,
        ctx.user.id,
      );

      const list = await listOrgModelProviderKeys(ctx.orgId);
      const custom = list.filter((k) => k.source === "custom");
      expect(custom).toHaveLength(1);
      // The list shape is `OrgModelProviderKeyInfo` — must not contain any `apiKey`
      // or `apiKeyEncrypted` field; only metadata.
      const serialized = JSON.stringify(custom[0]);
      expect(serialized).not.toContain(PLAINTEXT);
      expect(serialized).not.toContain("apiKeyEncrypted");
      expect(serialized).not.toContain("apiKey");
    });
  });

  describe("cross-org isolation", () => {
    it("loadModelProviderKeyCredentials returns null when the key belongs to a different org", async () => {
      const ctxA = await createTestContext({ orgSlug: "vault-iso-a" });
      const ctxB = await createTestContext({ orgSlug: "vault-iso-b" });
      const idA = await createOrgModelProviderKey(
        ctxA.orgId,
        "A",
        "anthropic-messages",
        "https://example.invalid",
        "secret-a",
        ctxA.user.id,
      );

      // Org B asks for org A's key id — must not get it.
      const leaked = await loadModelProviderKeyCredentials(ctxB.orgId, idA);
      expect(leaked).toBeNull();

      // Owner still sees it.
      const own = await loadModelProviderKeyCredentials(ctxA.orgId, idA);
      expect(own?.apiKey).toBe("secret-a");
    });

    it("updateOrgModelProviderKey scoped by org — org B's update does not touch org A's row", async () => {
      const ctxA = await createTestContext({ orgSlug: "vault-iso-update-a" });
      const ctxB = await createTestContext({ orgSlug: "vault-iso-update-b" });
      const idA = await createOrgModelProviderKey(
        ctxA.orgId,
        "A",
        "anthropic-messages",
        "https://example.invalid",
        "secret-original",
        ctxA.user.id,
      );

      // Org B tries to update org A's row using org A's id — silent no-op.
      await updateOrgModelProviderKey(ctxB.orgId, idA, { apiKey: "stolen" });

      const [row] = await db
        .select()
        .from(orgSystemProviderKeys)
        .where(eq(orgSystemProviderKeys.id, idA));
      // Encrypted blob must still decrypt to org A's original secret.
      const own = await loadModelProviderKeyCredentials(ctxA.orgId, idA);
      expect(own?.apiKey).toBe("secret-original");
      expect(row!.orgId).toBe(ctxA.orgId);
    });

    it("deleteOrgModelProviderKey scoped by org — org B's delete does not remove org A's row", async () => {
      const ctxA = await createTestContext({ orgSlug: "vault-iso-del-a" });
      const ctxB = await createTestContext({ orgSlug: "vault-iso-del-b" });
      const idA = await createOrgModelProviderKey(
        ctxA.orgId,
        "A",
        "anthropic-messages",
        "https://example.invalid",
        "secret-keep",
        ctxA.user.id,
      );

      await deleteOrgModelProviderKey(ctxB.orgId, idA);
      const own = await loadModelProviderKeyCredentials(ctxA.orgId, idA);
      expect(own?.apiKey).toBe("secret-keep");
    });
  });

  describe("rotation", () => {
    it("updating apiKey re-encrypts; the new plaintext decrypts and the old envelope is replaced", async () => {
      const ctx = await createTestContext({ orgSlug: "vault-rotate" });
      const id = await createOrgModelProviderKey(
        ctx.orgId,
        "rot",
        "anthropic-messages",
        "https://example.invalid",
        "old-secret",
        ctx.user.id,
      );
      const [before] = await db
        .select({ blob: orgSystemProviderKeys.apiKeyEncrypted })
        .from(orgSystemProviderKeys)
        .where(eq(orgSystemProviderKeys.id, id));

      await updateOrgModelProviderKey(ctx.orgId, id, { apiKey: "new-secret" });

      const [after] = await db
        .select({ blob: orgSystemProviderKeys.apiKeyEncrypted })
        .from(orgSystemProviderKeys)
        .where(eq(orgSystemProviderKeys.id, id));
      expect(after!.blob).not.toBe(before!.blob);
      const creds = await loadModelProviderKeyCredentials(ctx.orgId, id);
      expect(creds?.apiKey).toBe("new-secret");
    });

    it("updating only metadata leaves the encrypted blob untouched", async () => {
      const ctx = await createTestContext({ orgSlug: "vault-meta" });
      const id = await createOrgModelProviderKey(
        ctx.orgId,
        "meta",
        "anthropic-messages",
        "https://example.invalid",
        "stable-secret",
        ctx.user.id,
      );
      const [before] = await db
        .select({ blob: orgSystemProviderKeys.apiKeyEncrypted })
        .from(orgSystemProviderKeys)
        .where(eq(orgSystemProviderKeys.id, id));

      await updateOrgModelProviderKey(ctx.orgId, id, { label: "renamed" });

      const [after] = await db
        .select({ blob: orgSystemProviderKeys.apiKeyEncrypted, label: orgSystemProviderKeys.label })
        .from(orgSystemProviderKeys)
        .where(eq(orgSystemProviderKeys.id, id));
      expect(after!.blob).toBe(before!.blob);
      expect(after!.label).toBe("renamed");
    });
  });

  /**
   * OAuth path coverage — `loadModelProviderKeyCredentials` has two distinct
   * branches: API key (covered above) and OAuth (covered here). Both bug 2
   * (returned null for OAuth rows) and bug 4 (silently dropped `accountId`
   * from the return shape during a `replace_all` refactor) lived in this
   * branch — the regressions reached production because nothing in the
   * test suite exercised this path end-to-end.
   *
   * The setup uses `importOAuthModelProviderConnection` rather than hand-
   * building rows: it mirrors the prod control-flow exactly (insert
   * connection + key + decrypted creds) and would catch any future drift
   * between import and read shapes.
   */
  describe("OAuth path", () => {
    let userId: string;
    let orgId: string;
    let applicationId: string;

    beforeEach(async () => {
      // truncateAll() already ran in the outer beforeEach.
      const user = await createTestUser();
      userId = user.id;
      const { org, defaultAppId } = await createTestOrg(userId, { slug: "vault-oauth" });
      orgId = org.id;
      applicationId = defaultAppId;
      // No FK seeding required since Phase 4 — OAuth credentials live in
      // `model_provider_credentials` which has no FK to `packages`.
    });

    it("Codex: returns access token + providerPackageId + accountId from connection", async () => {
      const accessJwt = makeFakeCodexJwt({
        chatgpt_account_id: "acc-codex-123",
        email: "user@example.com",
      });
      const imported = await importOAuthModelProviderConnection({
        orgId,
        applicationId,
        userId,
        providerPackageId: CODEX,
        label: "ChatGPT Pro",
        accessToken: accessJwt,
        refreshToken: "rt-codex",
        expiresAt: Date.now() + 3600 * 1000,
      });

      const creds = await loadModelProviderKeyCredentials(orgId, imported.providerKeyId);
      expect(creds).not.toBeNull();
      // Bug 2 regression guard — OAuth rows must not return null on read.
      expect(creds!.apiKey).toBe(accessJwt);
      // Bug 4 regression guard — accountId must be propagated through the
      // return shape (a missing field here is what surfaced as the
      // "Missing chatgpt-account-id" error in the model-test endpoint).
      expect(creds!.accountId).toBe("acc-codex-123");
      // providerPackageId is what the inference probe branches on to apply
      // the Codex-specific request shape (`/codex/responses` + the account
      // header). Phase 4 normalizes to the canonical short providerId form;
      // org-models accepts both legacy + canonical for backward compat.
      expect(creds!.providerPackageId).toBe("codex");
    });

    it("Claude: returns access token + providerPackageId; accountId stays undefined (Codex-only field)", async () => {
      const imported = await importOAuthModelProviderConnection({
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

      const creds = await loadModelProviderKeyCredentials(orgId, imported.providerKeyId);
      expect(creds).not.toBeNull();
      expect(creds!.apiKey).toBe("sk-ant-oat01-fake");
      expect(creds!.providerPackageId).toBe("claude-code");
      // Anthropic OAuth carries no account-scoping claim — `accountId`
      // staying undefined is the contract (lets the inference probe skip
      // the `chatgpt-account-id` header it would otherwise require).
      expect(creds!.accountId).toBeUndefined();
    });

    it("returns null when the underlying OAuth connection needs reconnection", async () => {
      const imported = await importOAuthModelProviderConnection({
        orgId,
        applicationId,
        userId,
        providerPackageId: CLAUDE,
        label: "Claude (about to revoke)",
        accessToken: "sk-ant-oat01-fake",
        refreshToken: "sk-ant-ort01-fake",
        expiresAt: Date.now() + 3600 * 1000,
      });

      // Simulate the refresh worker flagging the credential after a
      // 400 invalid_grant from the upstream provider.
      await markCredentialNeedsReconnection(orgId, imported.providerKeyId);

      // The legacy load helper returns null when the OAuth blob's
      // needsReconnection flag is set, so callers fall through to their
      // own "key unusable" handling (route returns KEY_NOT_FOUND).
      const creds = await loadModelProviderKeyCredentials(orgId, imported.providerKeyId);
      expect(creds).toBeNull();
    });

    it("cross-org isolation: org B cannot read org A's OAuth-backed key", async () => {
      const importedA = await importOAuthModelProviderConnection({
        orgId,
        applicationId,
        userId,
        providerPackageId: CLAUDE,
        label: "Claude org-A",
        accessToken: "sk-ant-oat01-orgA",
        refreshToken: "sk-ant-ort01-orgA",
        expiresAt: Date.now() + 3600 * 1000,
      });

      const userB = await createTestUser({ email: "b@example.com" });
      const { org: orgB } = await createTestOrg(userB.id, { slug: "vault-oauth-b" });

      const leaked = await loadModelProviderKeyCredentials(orgB.id, importedA.providerKeyId);
      expect(leaked).toBeNull();

      // Owner still resolves correctly — sanity check.
      const own = await loadModelProviderKeyCredentials(orgId, importedA.providerKeyId);
      expect(own?.apiKey).toBe("sk-ant-oat01-orgA");
    });
  });
});
