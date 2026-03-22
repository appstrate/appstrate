import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/index.ts";
import { schemaStubs, db, resetQueues } from "../../services/__tests__/_db-mock.ts";
import { ApiError } from "../../lib/errors.ts";

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));
mock.module("@appstrate/db/schema", () => schemaStubs);

mock.module("../../middleware/guards.ts", () => ({
  requireAdmin: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  requireFlow: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  requireOwnedPackage: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  requireMutableFlow: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  checkScopeMatch: () => null,
}));

// --- Controllable mock state for users service ---

let mockCreateResult: unknown = {};
let mockListResult: unknown = { object: "list", data: [], hasMore: false, limit: 20 };
let mockGetResult: unknown = {};
let mockUpdateResult: unknown = {};
let mockGetThrow: ApiError | null = null;
let mockCreateThrow: ApiError | null = null;

mock.module("../../services/users.ts", () => ({
  createUser: async () => {
    if (mockCreateThrow) throw mockCreateThrow;
    return mockCreateResult;
  },
  listUsers: async () => mockListResult,
  getUser: async () => {
    if (mockGetThrow) throw mockGetThrow;
    return mockGetResult;
  },
  updateUser: async () => {
    if (mockGetThrow) throw mockGetThrow;
    return mockUpdateResult;
  },
  deleteUser: async () => {
    if (mockGetThrow) throw mockGetThrow;
  },
  validateMetadata: (metadata: unknown) => {
    if (metadata === null || metadata === undefined) return { valid: true, data: {} };
    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      return { valid: false, message: "metadata must be an object" };
    }
    for (const [, value] of Object.entries(metadata as Record<string, unknown>)) {
      if (typeof value !== "string") {
        return { valid: false, message: "metadata values must be strings" };
      }
    }
    return { valid: true, data: metadata };
  },
  isOrgMember: async () => null,
}));

const { requestId } = await import("../../middleware/request-id.ts");
const { errorHandler } = await import("../../middleware/error-handler.ts");
const { createUsersRouter } = await import("../users.ts");

// --- Test app ---

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.use("*", requestId());
app.use("*", async (c, next) => {
  c.set("orgId", "org-1");
  c.set("orgSlug", "test");
  c.set("user", { id: "admin-1", email: "admin@test.com", name: "Admin" });
  c.set("orgRole", "admin");
  c.set("authMethod", "api_key");
  await next();
});
app.route("/api/users", createUsersRouter());

function jsonRequest(path: string, method: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

beforeEach(() => {
  resetQueues();
  mockCreateResult = {};
  mockListResult = { object: "list", data: [], hasMore: false, limit: 20 };
  mockGetResult = {};
  mockUpdateResult = {};
  mockGetThrow = null;
  mockCreateThrow = null;
});

// ==================== POST /api/users ====================

describe("POST /api/users", () => {
  test("creates user → 201 with object: user", async () => {
    mockCreateResult = {
      id: "usr_abc",
      object: "user",
      name: "Alice",
      email: "alice@test.com",
      externalId: "ext_1",
      source: "api",
      metadata: { plan: "pro" },
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const res = await jsonRequest("/api/users", "POST", {
      name: "Alice",
      email: "alice@test.com",
      externalId: "ext_1",
      metadata: { plan: "pro" },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; object: string; source: string };
    expect(json.object).toBe("user");
    expect(json.source).toBe("api");
    expect(json.id).toBe("usr_abc");
  });

  test("rejects duplicate externalId → 409", async () => {
    mockCreateThrow = new ApiError({
      status: 409,
      code: "external_id_taken",
      title: "Conflict",
      detail: "externalId 'dup_id' is already in use",
      param: "externalId",
    });

    const res = await jsonRequest("/api/users", "POST", { externalId: "dup_id" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("external_id_taken");
  });

  test("rejects invalid metadata (non-string value) → 400", async () => {
    const res = await jsonRequest("/api/users", "POST", {
      metadata: { key: 123 },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string; param: string };
    expect(json.code).toBe("invalid_request");
    expect(json.param).toBe("metadata");
  });

  test("creates user with empty body → 201", async () => {
    mockCreateResult = {
      id: "usr_min",
      object: "user",
      name: null,
      email: null,
      externalId: null,
      source: "api",
      metadata: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const res = await jsonRequest("/api/users", "POST", {});
    expect(res.status).toBe(201);
  });
});

// ==================== GET /api/users ====================

describe("GET /api/users", () => {
  test("returns list with object: list", async () => {
    mockListResult = {
      object: "list",
      data: [
        { id: "usr_1", object: "user", name: "Alice", source: "api", createdAt: "2026-01-01" },
      ],
      hasMore: false,
      limit: 20,
    };

    const res = await app.request("/api/users");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object: string; data: unknown[]; hasMore: boolean };
    expect(json.object).toBe("list");
    expect(json.data).toHaveLength(1);
    expect(json.hasMore).toBe(false);
  });

  test("returns empty list", async () => {
    const res = await app.request("/api/users");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toEqual([]);
  });

  test("rejects startingAfter + endingBefore together → 400", async () => {
    const res = await app.request("/api/users?startingAfter=usr_1&endingBefore=usr_2");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("invalid_request");
  });
});

// ==================== GET /api/users/:id ====================

describe("GET /api/users/:id", () => {
  test("returns user by ID", async () => {
    mockGetResult = {
      id: "usr_abc",
      object: "user",
      name: "Bob",
      email: "bob@test.com",
      externalId: "ext_123",
      source: "api",
      metadata: { plan: "free" },
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const res = await app.request("/api/users/usr_abc");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; object: string };
    expect(json.id).toBe("usr_abc");
    expect(json.object).toBe("user");
  });

  test("returns 404 for unknown user", async () => {
    mockGetThrow = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "User not found",
    });

    const res = await app.request("/api/users/usr_unknown");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("not_found");
  });
});

// ==================== PATCH /api/users/:id ====================

describe("PATCH /api/users/:id", () => {
  test("updates name → 200", async () => {
    mockUpdateResult = {
      id: "usr_abc",
      object: "user",
      name: "New Name",
      email: "old@test.com",
      source: "api",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const res = await jsonRequest("/api/users/usr_abc", "PATCH", { name: "New Name" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { name: string };
    expect(json.name).toBe("New Name");
  });

  test("returns 404 for unknown user", async () => {
    mockGetThrow = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "User not found",
    });

    const res = await jsonRequest("/api/users/usr_unknown", "PATCH", { name: "X" });
    expect(res.status).toBe(404);
  });
});

// ==================== DELETE /api/users/:id ====================

describe("DELETE /api/users/:id", () => {
  test("deletes user → 204", async () => {
    const res = await app.request("/api/users/usr_abc", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  test("returns 404 for unknown user", async () => {
    mockGetThrow = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "User not found",
    });

    const res = await app.request("/api/users/usr_unknown", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
