// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  generateApiKey,
  hashApiKey,
  extractKeyPrefix,
  createApiKeyRecord,
  validateApiKey,
  listApiKeys,
  revokeApiKey,
} from "../../../src/services/api-keys.ts";

describe("api-keys service", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  // ── generateApiKey ──────────────────────────────────────────

  describe("generateApiKey", () => {
    it("returns a string starting with 'ask_'", () => {
      const key = generateApiKey();

      expect(key).toStartWith("ask_");
    });

    it("returns ask_ prefix + 48 hex characters", () => {
      const key = generateApiKey();

      expect(key).toHaveLength(4 + 48); // "ask_" (4) + 48 hex chars
      expect(key.slice(4)).toMatch(/^[0-9a-f]{48}$/);
    });

    it("returns unique values on successive calls", () => {
      const keys = new Set(Array.from({ length: 20 }, () => generateApiKey()));

      expect(keys.size).toBe(20);
    });
  });

  // ── hashApiKey ──────────────────────────────────────────────

  describe("hashApiKey", () => {
    it("returns a 64-character hex string (SHA-256)", async () => {
      const hash = await hashApiKey("ask_abc123");

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns a consistent hash for the same input", async () => {
      const input = "ask_consistent_test";
      const hash1 = await hashApiKey(input);
      const hash2 = await hashApiKey(input);

      expect(hash1).toBe(hash2);
    });

    it("returns different hashes for different inputs", async () => {
      const hash1 = await hashApiKey("ask_key_one");
      const hash2 = await hashApiKey("ask_key_two");

      expect(hash1).not.toBe(hash2);
    });
  });

  // ── extractKeyPrefix ────────────────────────────────────────

  describe("extractKeyPrefix", () => {
    it("returns the first 8 characters of the raw key", () => {
      const key = generateApiKey();
      const prefix = extractKeyPrefix(key);

      expect(prefix).toBe(key.slice(0, 8));
      expect(prefix).toHaveLength(8);
    });
  });

  // ── createApiKeyRecord ──────────────────────────────────────

  describe("createApiKeyRecord", () => {
    it("inserts a record and returns its ID", async () => {
      const rawKey = generateApiKey();
      const hash = await hashApiKey(rawKey);

      const id = await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Test Key",
        keyHash: hash,
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    it("created record is retrievable via listApiKeys", async () => {
      const rawKey = generateApiKey();
      const hash = await hashApiKey(rawKey);

      await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Listed Key",
        keyHash: hash,
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      const keys = await listApiKeys({ orgId: ctx.orgId });
      expect(keys).toHaveLength(1);
      expect(keys[0]!.name).toBe("Listed Key");
    });
  });

  // ── validateApiKey ──────────────────────────────────────────

  describe("validateApiKey", () => {
    it("returns user info for a valid key", async () => {
      const rawKey = generateApiKey();
      const hash = await hashApiKey(rawKey);

      await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Valid Key",
        keyHash: hash,
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      const result = await validateApiKey(rawKey);

      expect(result).not.toBeNull();
      expect(result!.userId).toBe(ctx.user.id);
      expect(result!.email).toBe(ctx.user.email);
      expect(result!.orgId).toBe(ctx.orgId);
      expect(result!.orgSlug).toBe(ctx.org.slug);
      expect(result!.applicationId).toBe(ctx.defaultAppId);
      expect(result!.keyId).toBeDefined();
    });

    it("returns null for an invalid (unknown) key", async () => {
      const fakeKey = generateApiKey();

      const result = await validateApiKey(fakeKey);

      expect(result).toBeNull();
    });

    it("returns null for a key without the ask_ prefix", async () => {
      const result = await validateApiKey("not_a_valid_prefix_key");

      expect(result).toBeNull();
    });

    it("returns null for a revoked key", async () => {
      const rawKey = generateApiKey();
      const hash = await hashApiKey(rawKey);

      const keyId = await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Revoked Key",
        keyHash: hash,
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      await revokeApiKey({ orgId: ctx.orgId }, keyId);

      const result = await validateApiKey(rawKey);
      expect(result).toBeNull();
    });

    it("returns null for an expired key", async () => {
      const rawKey = generateApiKey();
      const hash = await hashApiKey(rawKey);

      // Set expiresAt in the past
      const pastDate = new Date(Date.now() - 60_000);

      await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Expired Key",
        keyHash: hash,
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: ctx.user.id,
        expiresAt: pastDate,
      });

      const result = await validateApiKey(rawKey);
      expect(result).toBeNull();
    });

    it("returns user info for a key with a future expiration", async () => {
      const rawKey = generateApiKey();
      const hash = await hashApiKey(rawKey);

      const futureDate = new Date(Date.now() + 86_400_000); // +1 day

      await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Future Expiry Key",
        keyHash: hash,
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: ctx.user.id,
        expiresAt: futureDate,
      });

      const result = await validateApiKey(rawKey);

      expect(result).not.toBeNull();
      expect(result!.userId).toBe(ctx.user.id);
    });
  });

  // ── listApiKeys ─────────────────────────────────────────────

  describe("listApiKeys", () => {
    it("returns active keys for the org", async () => {
      const rawKey1 = generateApiKey();
      const rawKey2 = generateApiKey();

      await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Key One",
        keyHash: await hashApiKey(rawKey1),
        keyPrefix: extractKeyPrefix(rawKey1),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Key Two",
        keyHash: await hashApiKey(rawKey2),
        keyPrefix: extractKeyPrefix(rawKey2),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      const keys = await listApiKeys({ orgId: ctx.orgId });

      expect(keys).toHaveLength(2);
      const names = keys.map((k) => k.name);
      expect(names).toContain("Key One");
      expect(names).toContain("Key Two");
    });

    it("does not return keys belonging to another org", async () => {
      const otherCtx = await createTestContext();

      const rawKey = generateApiKey();
      await createApiKeyRecord({
        scope: { orgId: otherCtx.orgId, applicationId: otherCtx.defaultAppId },
        name: "Other Org Key",
        keyHash: await hashApiKey(rawKey),
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: otherCtx.user.id,
        expiresAt: null,
      });

      const keys = await listApiKeys({ orgId: ctx.orgId });

      expect(keys).toHaveLength(0);
    });

    it("does not return revoked keys", async () => {
      const rawKey = generateApiKey();
      const keyId = await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Soon Revoked",
        keyHash: await hashApiKey(rawKey),
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      await revokeApiKey({ orgId: ctx.orgId }, keyId);

      const keys = await listApiKeys({ orgId: ctx.orgId });

      expect(keys).toHaveLength(0);
    });

    it("includes creator info from profiles/user join", async () => {
      const rawKey = generateApiKey();
      await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Creator Info Key",
        keyHash: await hashApiKey(rawKey),
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      const keys = await listApiKeys({ orgId: ctx.orgId });

      expect(keys).toHaveLength(1);
      expect(keys[0]!.createdBy).toBe(ctx.user.id);
      // createdByName comes from profiles.displayName or user.name
      expect(keys[0]!.createdByName).toBeDefined();
    });

    it("returns keys with expected shape", async () => {
      const rawKey = generateApiKey();
      const prefix = extractKeyPrefix(rawKey);

      await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Shape Test Key",
        keyHash: await hashApiKey(rawKey),
        keyPrefix: prefix,
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      const keys = await listApiKeys({ orgId: ctx.orgId });

      expect(keys).toHaveLength(1);
      const key = keys[0]!;

      expect(key.id).toBeDefined();
      expect(key.name).toBe("Shape Test Key");
      expect(key.keyPrefix).toBe(prefix);
      expect(key.scopes).toEqual([]);
      expect(key.createdAt).toBeDefined();
      expect(key.revokedAt).toBeNull();
      expect(key.lastUsedAt).toBeNull();
      expect(key.expiresAt).toBeNull();
    });

    it("filters by applicationId when provided", async () => {
      const rawKey1 = generateApiKey();
      const rawKey2 = generateApiKey();

      await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Default App Key",
        keyHash: await hashApiKey(rawKey1),
        keyPrefix: extractKeyPrefix(rawKey1),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      // Create a second application for the same org
      const { db } = await import("../../helpers/db.ts");
      const { applications } = await import("@appstrate/db/schema");
      const otherAppId = `app_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await db.insert(applications).values({
        id: otherAppId,
        orgId: ctx.orgId,
        name: "Other App",
        isDefault: false,
        createdBy: ctx.user.id,
      });

      await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: otherAppId },
        name: "Other App Key",
        keyHash: await hashApiKey(rawKey2),
        keyPrefix: extractKeyPrefix(rawKey2),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      const defaultAppKeys = await listApiKeys(
        { orgId: ctx.orgId },
        { applicationId: ctx.defaultAppId },
      );
      expect(defaultAppKeys).toHaveLength(1);
      expect(defaultAppKeys[0]!.name).toBe("Default App Key");

      const otherAppKeys = await listApiKeys({ orgId: ctx.orgId }, { applicationId: otherAppId });
      expect(otherAppKeys).toHaveLength(1);
      expect(otherAppKeys[0]!.name).toBe("Other App Key");

      // Without filter returns all
      const allKeys = await listApiKeys({ orgId: ctx.orgId });
      expect(allKeys).toHaveLength(2);
    });
  });

  // ── revokeApiKey ────────────────────────────────────────────

  describe("revokeApiKey", () => {
    it("soft-deletes the key and returns true", async () => {
      const rawKey = generateApiKey();
      const keyId = await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "To Revoke",
        keyHash: await hashApiKey(rawKey),
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      const result = await revokeApiKey({ orgId: ctx.orgId }, keyId);

      expect(result).toBe(true);

      // Key should no longer appear in active list
      const keys = await listApiKeys({ orgId: ctx.orgId });
      expect(keys).toHaveLength(0);
    });

    it("returns false for a non-existent key ID", async () => {
      const result = await revokeApiKey({ orgId: ctx.orgId }, crypto.randomUUID());

      expect(result).toBe(false);
    });

    it("returns false when revoking another org's key", async () => {
      const otherCtx = await createTestContext();

      const rawKey = generateApiKey();
      const keyId = await createApiKeyRecord({
        scope: { orgId: otherCtx.orgId, applicationId: otherCtx.defaultAppId },
        name: "Other Org Key",
        keyHash: await hashApiKey(rawKey),
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: otherCtx.user.id,
        expiresAt: null,
      });

      // Attempt to revoke with the wrong orgId
      const result = await revokeApiKey({ orgId: ctx.orgId }, keyId);

      expect(result).toBe(false);

      // Key should still be active for the owning org
      const keys = await listApiKeys({ orgId: otherCtx.orgId });
      expect(keys).toHaveLength(1);
    });

    it("returns false when revoking an already-revoked key", async () => {
      const rawKey = generateApiKey();
      const keyId = await createApiKeyRecord({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        name: "Double Revoke",
        keyHash: await hashApiKey(rawKey),
        keyPrefix: extractKeyPrefix(rawKey),
        createdBy: ctx.user.id,
        expiresAt: null,
      });

      const first = await revokeApiKey({ orgId: ctx.orgId }, keyId);
      expect(first).toBe(true);

      const second = await revokeApiKey({ orgId: ctx.orgId }, keyId);
      expect(second).toBe(false);
    });
  });
});
