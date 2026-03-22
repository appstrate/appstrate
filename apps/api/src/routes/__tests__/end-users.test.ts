import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/index.ts";
import { ApiError } from "../../lib/errors.ts";

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

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

mock.module("../../middleware/rate-limit.ts", () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  _setMemoryBackendForTesting: () => {},
}));

// --- Controllable mock state ---

const now = new Date("2026-01-15T10:00:00Z");

let mockCreateResult: unknown = {};
let mockCreateThrow: Error | null = null;
let mockListResult: unknown = { object: "list", data: [], hasMore: false, limit: 20 };
let mockGetResult: unknown = {};
let mockGetThrow: Error | null = null;
let mockUpdateResult: unknown = {};
let mockUpdateThrow: Error | null = null;
let mockDeleteThrow: Error | null = null;

mock.module("../../services/end-users.ts", () => ({
  createEndUser: async () => {
    if (mockCreateThrow) throw mockCreateThrow;
    return mockCreateResult;
  },
  listEndUsers: async () => mockListResult,
  getEndUser: async () => {
    if (mockGetThrow) throw mockGetThrow;
    return mockGetResult;
  },
  updateEndUser: async () => {
    if (mockUpdateThrow) throw mockUpdateThrow;
    return mockUpdateResult;
  },
  deleteEndUser: async () => {
    if (mockDeleteThrow) throw mockDeleteThrow;
  },
  validateMetadata: (metadata: unknown) => {
    if (metadata === null || metadata === undefined) {
      return { valid: true, data: {} };
    }
    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      return { valid: false, message: "metadata must be an object" };
    }
    return { valid: true, data: metadata };
  },
  findByExternalId: async () => null,
  isEndUserInApp: async () => null,
}));

const { requestId } = await import("../../middleware/request-id.ts");
const { errorHandler } = await import("../../middleware/error-handler.ts");
const { createEndUsersRouter } = await import("../end-users.ts");

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
app.route("/api/end-users", createEndUsersRouter());

function jsonRequest(path: string, method: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

beforeEach(() => {
  mockCreateResult = {};
  mockCreateThrow = null;
  mockListResult = { object: "list", data: [], hasMore: false, limit: 20 };
  mockGetResult = {};
  mockGetThrow = null;
  mockUpdateResult = {};
  mockUpdateThrow = null;
  mockDeleteThrow = null;
});

// ---------------------------------------------------------------------------
// POST /api/end-users
// ---------------------------------------------------------------------------

describe("POST /api/end-users", () => {
  test("creates end-user with eu_ prefix and returns 201", async () => {
    mockCreateResult = {
      id: "eu_abc123",
      object: "end_user",
      applicationId: "app_default",
      name: "John Doe",
      email: "john@example.com",
      externalId: null,
      metadata: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const res = await jsonRequest("/api/end-users", "POST", {
      name: "John Doe",
      email: "john@example.com",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; object: string; name: string };
    expect(json.object).toBe("end_user");
    expect(json.id).toStartWith("eu_");
    expect(json.name).toBe("John Doe");
  });

  test("uses default application when applicationId is omitted", async () => {
    mockCreateResult = {
      id: "eu_no_app",
      object: "end_user",
      applicationId: "app_default",
      name: null,
      email: null,
      externalId: null,
      metadata: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const res = await jsonRequest("/api/end-users", "POST", {});
    expect(res.status).toBe(201);
    const json = (await res.json()) as { applicationId: string };
    expect(json.applicationId).toBe("app_default");
  });

  test("creates end-user with explicit applicationId", async () => {
    mockCreateResult = {
      id: "eu_with_app",
      object: "end_user",
      applicationId: "app_custom",
      name: null,
      email: null,
      externalId: null,
      metadata: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const res = await jsonRequest("/api/end-users", "POST", {
      applicationId: "app_custom",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { applicationId: string };
    expect(json.applicationId).toBe("app_custom");
  });

  test("returns 409 when externalId is already taken", async () => {
    mockCreateThrow = new ApiError({
      status: 409,
      code: "external_id_taken",
      title: "Conflict",
      detail: "externalId 'user-123' is already in use in this application",
      param: "externalId",
    });

    const res = await jsonRequest("/api/end-users", "POST", {
      externalId: "user-123",
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("external_id_taken");
  });

  test("rejects invalid metadata (array) with 400", async () => {
    const res = await jsonRequest("/api/end-users", "POST", {
      metadata: [1, 2, 3],
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string; detail: string };
    expect(json.code).toBe("invalid_request");
    expect(json.detail).toContain("metadata");
  });
});

// ---------------------------------------------------------------------------
// GET /api/end-users
// ---------------------------------------------------------------------------

describe("GET /api/end-users", () => {
  test("returns list of end-users", async () => {
    mockListResult = {
      object: "list",
      data: [
        {
          id: "eu_1",
          object: "end_user",
          applicationId: "app_default",
          name: "Alice",
          email: "alice@example.com",
          externalId: null,
          metadata: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
      hasMore: false,
      limit: 20,
    };

    const res = await app.request("/api/end-users");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object: string; data: { id: string }[]; hasMore: boolean };
    expect(json.object).toBe("list");
    expect(json.data).toHaveLength(1);
    expect(json.data[0]!.id).toBe("eu_1");
    expect(json.hasMore).toBe(false);
  });

  test("filters by applicationId query parameter", async () => {
    mockListResult = {
      object: "list",
      data: [
        {
          id: "eu_filtered",
          object: "end_user",
          applicationId: "app_specific",
          name: null,
          email: null,
          externalId: null,
          metadata: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
      hasMore: false,
      limit: 20,
    };

    const res = await app.request("/api/end-users?applicationId=app_specific");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { applicationId: string }[] };
    expect(json.data[0]!.applicationId).toBe("app_specific");
  });

  test("filters by externalId query parameter", async () => {
    mockListResult = {
      object: "list",
      data: [
        {
          id: "eu_ext",
          object: "end_user",
          applicationId: "app_default",
          name: null,
          email: null,
          externalId: "ext-123",
          metadata: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
      hasMore: false,
      limit: 20,
    };

    const res = await app.request("/api/end-users?externalId=ext-123");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { externalId: string }[] };
    expect(json.data[0]!.externalId).toBe("ext-123");
  });

  test("supports cursor pagination with startingAfter", async () => {
    mockListResult = {
      object: "list",
      data: [
        {
          id: "eu_page2",
          object: "end_user",
          applicationId: "app_default",
          name: null,
          email: null,
          externalId: null,
          metadata: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
      hasMore: false,
      limit: 20,
    };

    const res = await app.request("/api/end-users?startingAfter=eu_cursor");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data).toHaveLength(1);
  });

  test("rejects mutually exclusive startingAfter and endingBefore with 400", async () => {
    const res = await app.request("/api/end-users?startingAfter=eu_a&endingBefore=eu_b");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("invalid_request");
  });

  test("returns empty list when no end-users exist", async () => {
    mockListResult = { object: "list", data: [], hasMore: false, limit: 20 };

    const res = await app.request("/api/end-users");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/end-users/:id
// ---------------------------------------------------------------------------

describe("GET /api/end-users/:id", () => {
  test("returns a single end-user", async () => {
    mockGetResult = {
      id: "eu_abc",
      object: "end_user",
      applicationId: "app_default",
      name: "Bob",
      email: "bob@example.com",
      externalId: "ext-bob",
      metadata: { role: "viewer" },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const res = await app.request("/api/end-users/eu_abc");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      id: string;
      object: string;
      name: string;
      metadata: { role: string };
    };
    expect(json.object).toBe("end_user");
    expect(json.id).toBe("eu_abc");
    expect(json.name).toBe("Bob");
    expect(json.metadata).toEqual({ role: "viewer" });
  });

  test("returns 404 for unknown end-user id", async () => {
    mockGetThrow = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "End-user 'eu_unknown' not found in this organization",
    });

    const res = await app.request("/api/end-users/eu_unknown");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/end-users/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/end-users/:id", () => {
  test("updates name and email", async () => {
    mockUpdateResult = {
      id: "eu_abc",
      object: "end_user",
      applicationId: "app_default",
      name: "New Name",
      email: "new@example.com",
      externalId: null,
      metadata: null,
      createdAt: now.toISOString(),
      updatedAt: new Date("2026-01-16T10:00:00Z").toISOString(),
    };

    const res = await jsonRequest("/api/end-users/eu_abc", "PATCH", {
      name: "New Name",
      email: "new@example.com",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { name: string; email: string };
    expect(json.name).toBe("New Name");
    expect(json.email).toBe("new@example.com");
  });

  test("merges metadata preserving existing keys", async () => {
    mockUpdateResult = {
      id: "eu_abc",
      object: "end_user",
      applicationId: "app_default",
      name: null,
      email: null,
      externalId: null,
      metadata: { existing: "kept", newKey: "added" },
      createdAt: now.toISOString(),
      updatedAt: new Date("2026-01-16T10:00:00Z").toISOString(),
    };

    const res = await jsonRequest("/api/end-users/eu_abc", "PATCH", {
      metadata: { newKey: "added" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { metadata: { existing: string; newKey: string } };
    expect(json.metadata).toEqual({ existing: "kept", newKey: "added" });
  });

  test("returns 404 for unknown end-user id", async () => {
    mockUpdateThrow = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "End-user 'eu_unknown' not found in this organization",
    });

    const res = await jsonRequest("/api/end-users/eu_unknown", "PATCH", {
      name: "Nope",
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("not_found");
  });

  test("returns 409 when updating externalId to taken value", async () => {
    mockUpdateThrow = new ApiError({
      status: 409,
      code: "external_id_taken",
      title: "Conflict",
      detail: "externalId 'taken-id' is already in use in this application",
      param: "externalId",
    });

    const res = await jsonRequest("/api/end-users/eu_abc", "PATCH", {
      externalId: "taken-id",
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("external_id_taken");
  });

  test("rejects invalid metadata (array) with 400", async () => {
    const res = await jsonRequest("/api/end-users/eu_abc", "PATCH", {
      metadata: [1, 2, 3],
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("invalid_request");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/end-users/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/end-users/:id", () => {
  test("deletes end-user and returns 204", async () => {
    const res = await app.request("/api/end-users/eu_abc", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  test("returns 404 for unknown end-user id", async () => {
    mockDeleteThrow = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "End-user 'eu_unknown' not found in this organization",
    });

    const res = await app.request("/api/end-users/eu_unknown", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("not_found");
  });
});
