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
import { createTestContext } from "../../helpers/auth.ts";
import {
  createOrgModelProviderKey,
  deleteOrgModelProviderKey,
  listOrgModelProviderKeys,
  loadModelProviderKeyCredentials,
  updateOrgModelProviderKey,
} from "../../../src/services/org-model-provider-keys.ts";

const PLAINTEXT = "sk-test-plaintext-do-not-leak-12345";

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
});
