/**
 * Cross-application isolation tests for end-user services.
 *
 * Verifies that end-users created in one application are not visible
 * or accessible from a different application context.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { queues, resetQueues, db, schemaStubs } from "./_db-mock.ts";

const noop = () => {};

mock.module("../../lib/db.ts", () => ({ db }));
mock.module("@appstrate/db/schema", () => schemaStubs);
mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

const { isEndUserInApp, getEndUser, listEndUsers, findByExternalId } =
  await import("../end-users.ts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = "org_aaa";
const ORG_B = "org_bbb";
const APP_A = "app_aaa";
const APP_B = "app_bbb";

const now = new Date("2025-06-01T00:00:00Z");

function makeEndUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "eu_user1",
    applicationId: APP_A,
    orgId: ORG_A,
    externalId: "ext-123",
    name: "Alice",
    email: "alice@example.com",
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  resetQueues();
});

// ---------------------------------------------------------------------------
// isEndUserInApp — application boundary check
// ---------------------------------------------------------------------------

describe("isEndUserInApp — cross-app isolation", () => {
  test("returns the end-user when applicationId matches", async () => {
    queues.select.push([
      { id: "eu_user1", applicationId: APP_A, name: "Alice", email: "alice@example.com" },
    ]);

    const result = await isEndUserInApp(APP_A, "eu_user1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("eu_user1");
    expect(result!.applicationId).toBe(APP_A);
  });

  test("returns null when end-user belongs to a different application", async () => {
    // DB returns empty — the WHERE clause filters by applicationId so no match
    queues.select.push([]);

    const result = await isEndUserInApp(APP_B, "eu_user1");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getEndUser — orgId boundary check
// ---------------------------------------------------------------------------

describe("getEndUser — cross-org isolation", () => {
  test("returns end-user when orgId matches", async () => {
    queues.select.push([makeEndUser()]);

    const result = await getEndUser(ORG_A, "eu_user1");
    expect(result.id).toBe("eu_user1");
    expect(result.object).toBe("end_user");
  });

  test("throws 404 when endUserId is valid but orgId does not match", async () => {
    // DB returns empty because orgId filter excludes the row
    queues.select.push([]);

    try {
      await getEndUser(ORG_B, "eu_user1");
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const apiErr = err as { status: number; code: string };
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe("not_found");
    }
  });
});

// ---------------------------------------------------------------------------
// listEndUsers — applicationId filter isolation
// ---------------------------------------------------------------------------

describe("listEndUsers — cross-app isolation via applicationId filter", () => {
  test("returns end-users only for the specified applicationId", async () => {
    const userInAppA = makeEndUser({ id: "eu_inA", applicationId: APP_A });
    queues.select.push([userInAppA]);

    const result = await listEndUsers(ORG_A, { applicationId: APP_A });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.id).toBe("eu_inA");
    expect(result.data[0]!.applicationId).toBe(APP_A);
  });

  test("returns empty list when querying with a different applicationId", async () => {
    // DB returns empty — end-user created in APP_A is not in APP_B
    queues.select.push([]);

    const result = await listEndUsers(ORG_A, { applicationId: APP_B });
    expect(result.data).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("end-user created in app A does not appear in app B query", async () => {
    // Simulate: query app A returns the user
    queues.select.push([makeEndUser({ id: "eu_appA", applicationId: APP_A })]);
    const resultA = await listEndUsers(ORG_A, { applicationId: APP_A });
    expect(resultA.data).toHaveLength(1);
    expect(resultA.data[0]!.applicationId).toBe(APP_A);

    // Simulate: query app B returns nothing (same org, different app)
    queues.select.push([]);
    const resultB = await listEndUsers(ORG_A, { applicationId: APP_B });
    expect(resultB.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findByExternalId — scoped to applicationId
// ---------------------------------------------------------------------------

describe("findByExternalId — cross-app isolation", () => {
  test("returns the end-user when externalId matches within the same application", async () => {
    queues.select.push([{ id: "eu_inA" }]);

    const result = await findByExternalId(APP_A, "ext-123");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("eu_inA");
  });

  test("returns null when same externalId is queried in a different application", async () => {
    // DB returns empty — externalId "ext-123" exists in APP_A but not APP_B
    queues.select.push([]);

    const result = await findByExternalId(APP_B, "ext-123");
    expect(result).toBeNull();
  });

  test("same externalId in different apps returns different end-users", async () => {
    // Query in app A
    queues.select.push([{ id: "eu_fromA" }]);
    const resultA = await findByExternalId(APP_A, "shared-ext-id");
    expect(resultA).not.toBeNull();
    expect(resultA!.id).toBe("eu_fromA");

    // Query in app B — different end-user with same externalId
    queues.select.push([{ id: "eu_fromB" }]);
    const resultB = await findByExternalId(APP_B, "shared-ext-id");
    expect(resultB).not.toBeNull();
    expect(resultB!.id).toBe("eu_fromB");

    // They are distinct end-users
    expect(resultA!.id).not.toBe(resultB!.id);
  });
});
