/**
 * Unit tests for api-keys service.
 *
 * Tests: generateApiKey, hashApiKey, validateApiKey, createApiKeyRecord,
 * listApiKeys, revokeApiKey.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { queues, resetQueues, tracking, db, schemaStubs } from "./_db-mock.ts";

// --- Mocks (must be before dynamic import) ---

const noop = () => {};
mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));

mock.module("@appstrate/db/schema", () => ({
  ...schemaStubs,
}));

// --- Dynamic imports (after mocks) ---

const {
  generateApiKey,
  hashApiKey,
  validateApiKey,
  createApiKeyRecord,
  listApiKeys,
  revokeApiKey,
} = await import("../api-keys.ts");

// --- Tests ---

beforeEach(() => {
  resetQueues();
});

describe("generateApiKey", () => {
  test("returns string with ask_ prefix", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^ask_/);
  });

  test("returns ask_ prefix + 48 hex chars (52 total)", () => {
    const key = generateApiKey();
    expect(key).toHaveLength(4 + 48); // "ask_" + 48 hex
    expect(key.slice(4)).toMatch(/^[0-9a-f]{48}$/);
  });

  test("generates unique keys", () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    expect(k1).not.toBe(k2);
  });
});

describe("hashApiKey", () => {
  test("returns a 64-char hex string (SHA-256)", async () => {
    const hash = await hashApiKey("ask_abc123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic: same input produces same output", async () => {
    const input = "ask_deterministic_test_key";
    const h1 = await hashApiKey(input);
    const h2 = await hashApiKey(input);
    expect(h1).toBe(h2);
  });

  test("different inputs produce different hashes", async () => {
    const h1 = await hashApiKey("ask_key_one");
    const h2 = await hashApiKey("ask_key_two");
    expect(h1).not.toBe(h2);
  });
});

describe("validateApiKey", () => {
  test("returns null for key without ask_ prefix", async () => {
    const result = await validateApiKey("invalid_prefix_key");
    expect(result).toBeNull();
  });

  test("happy path: returns validated key info", async () => {
    const rawKey = generateApiKey();

    // Queue the select result for the DB lookup
    queues.select.push([
      {
        id: "key-1",
        orgId: "org-1",
        applicationId: "app-1",
        createdBy: "user-1",
        expiresAt: null,
        revokedAt: null,
        userName: "Test User",
        userEmail: "test@example.com",
        orgSlug: "test-org",
      },
    ]);

    const result = await validateApiKey(rawKey);

    expect(result).not.toBeNull();
    expect(result!.keyId).toBe("key-1");
    expect(result!.userId).toBe("user-1");
    expect(result!.orgId).toBe("org-1");
    expect(result!.applicationId).toBe("app-1");
    expect(result!.email).toBe("test@example.com");
    expect(result!.name).toBe("Test User");
    expect(result!.orgSlug).toBe("test-org");
  });

  test("returns null when key not found in DB", async () => {
    const rawKey = generateApiKey();

    // Queue empty result (no matching key)
    queues.select.push([]);

    const result = await validateApiKey(rawKey);
    expect(result).toBeNull();
  });

  test("returns null when key is revoked", async () => {
    const rawKey = generateApiKey();

    queues.select.push([
      {
        id: "key-2",
        orgId: "org-1",
        applicationId: "app-1",
        createdBy: "user-1",
        expiresAt: null,
        revokedAt: new Date("2025-01-01"),
        userName: "Test User",
        userEmail: "test@example.com",
        orgSlug: "test-org",
      },
    ]);

    const result = await validateApiKey(rawKey);
    expect(result).toBeNull();
  });

  test("returns null when key is expired", async () => {
    const rawKey = generateApiKey();

    queues.select.push([
      {
        id: "key-3",
        orgId: "org-1",
        applicationId: "app-1",
        createdBy: "user-1",
        expiresAt: new Date("2020-01-01"), // expired
        revokedAt: null,
        userName: "Test User",
        userEmail: "test@example.com",
        orgSlug: "test-org",
      },
    ]);

    const result = await validateApiKey(rawKey);
    expect(result).toBeNull();
  });

  test("returns key info when expiresAt is in the future", async () => {
    const rawKey = generateApiKey();

    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);

    queues.select.push([
      {
        id: "key-4",
        orgId: "org-1",
        applicationId: "app-1",
        createdBy: "user-1",
        expiresAt: futureDate,
        revokedAt: null,
        userName: "Test User",
        userEmail: "test@example.com",
        orgSlug: "test-org",
      },
    ]);

    const result = await validateApiKey(rawKey);
    expect(result).not.toBeNull();
    expect(result!.keyId).toBe("key-4");
  });
});

describe("createApiKeyRecord", () => {
  test("inserts a record and returns the generated ID", async () => {
    const params = {
      orgId: "org-1",
      applicationId: "app-1",
      name: "My API Key",
      keyHash: "abc123hash",
      keyPrefix: "ask_abcd",
      createdBy: "user-1",
      expiresAt: null,
    };

    const id = await createApiKeyRecord(params);

    // Should return a UUID
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    // Verify the insert was called with correct fields
    expect(tracking.insertCalls).toHaveLength(1);
    const inserted = tracking.insertCalls[0]!;
    expect(inserted.orgId).toBe("org-1");
    expect(inserted.applicationId).toBe("app-1");
    expect(inserted.name).toBe("My API Key");
    expect(inserted.keyHash).toBe("abc123hash");
    expect(inserted.keyPrefix).toBe("ask_abcd");
    expect(inserted.createdBy).toBe("user-1");
    expect(inserted.expiresAt).toBeNull();
  });

  test("stores expiresAt when provided", async () => {
    const expiry = new Date("2027-06-15");

    await createApiKeyRecord({
      orgId: "org-2",
      applicationId: "app-2",
      name: "Expiring Key",
      keyHash: "hash456",
      keyPrefix: "ask_efgh",
      createdBy: "user-2",
      expiresAt: expiry,
    });

    expect(tracking.insertCalls).toHaveLength(1);
    expect(tracking.insertCalls[0]!.expiresAt).toBe(expiry);
  });
});

describe("listApiKeys", () => {
  test("returns mapped API key info for an org", async () => {
    const now = new Date();
    queues.select.push([
      {
        id: "key-1",
        name: "Key One",
        keyPrefix: "ask_1234",
        scopes: ["read", "write"],
        createdBy: "user-1",
        expiresAt: null,
        lastUsedAt: now,
        revokedAt: null,
        createdAt: now,
        displayName: "Alice",
        userName: "alice",
      },
    ]);

    const result = await listApiKeys("org-1");

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("key-1");
    expect(result[0]!.name).toBe("Key One");
    expect(result[0]!.keyPrefix).toBe("ask_1234");
    expect(result[0]!.scopes).toEqual(["read", "write"]);
    expect(result[0]!.createdByName).toBe("Alice");
    expect(result[0]!.expiresAt).toBeNull();
    expect(result[0]!.lastUsedAt).toBe(now.toISOString());
    expect(result[0]!.revokedAt).toBeNull();
  });

  test("returns empty array when no keys exist", async () => {
    queues.select.push([]);

    const result = await listApiKeys("org-empty");
    expect(result).toEqual([]);
  });

  test("falls back to userName when displayName is null", async () => {
    const now = new Date();
    queues.select.push([
      {
        id: "key-2",
        name: "Key Two",
        keyPrefix: "ask_5678",
        scopes: null,
        createdBy: "user-2",
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now,
        displayName: null,
        userName: "bob",
      },
    ]);

    const result = await listApiKeys("org-1");

    expect(result[0]!.createdByName).toBe("bob");
    expect(result[0]!.scopes).toEqual([]); // null scopes → empty array
  });

  test("accepts optional applicationId filter", async () => {
    queues.select.push([]);

    // This should not throw — applicationId is an optional filter
    const result = await listApiKeys("org-1", "app-specific");
    expect(result).toEqual([]);
  });
});

describe("revokeApiKey", () => {
  test("returns true when key is successfully revoked", async () => {
    queues.update.push([{ id: "key-1" }]);

    const result = await revokeApiKey("key-1", "org-1");

    expect(result).toBe(true);
    expect(tracking.updateCalls).toHaveLength(1);
    expect(tracking.updateCalls[0]!.revokedAt).toBeInstanceOf(Date);
  });

  test("returns false when key not found or already revoked", async () => {
    queues.update.push([]); // no rows returned

    const result = await revokeApiKey("nonexistent", "org-1");
    expect(result).toBe(false);
  });
});
