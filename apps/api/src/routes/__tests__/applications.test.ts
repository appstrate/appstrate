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

// --- Controllable mock state ---

let mockCreateResult: unknown = {};
let mockCreateThrow: ApiError | null = null;
let mockListResult: unknown[] = [];
let mockGetResult: unknown = {};
let mockGetThrow: ApiError | null = null;
let mockUpdateResult: unknown = {};
let mockUpdateThrow: ApiError | null = null;
let mockDeleteThrow: ApiError | null = null;

mock.module("../../services/applications.ts", () => ({
  createApplication: async () => {
    if (mockCreateThrow) throw mockCreateThrow;
    return mockCreateResult;
  },
  listApplications: async () => mockListResult,
  getApplication: async () => {
    if (mockGetThrow) throw mockGetThrow;
    return mockGetResult;
  },
  updateApplication: async () => {
    if (mockUpdateThrow) throw mockUpdateThrow;
    return mockUpdateResult;
  },
  deleteApplication: async () => {
    if (mockDeleteThrow) throw mockDeleteThrow;
  },
  createDefaultApplication: async () => ({}),
  getDefaultApplication: async () => ({ id: "app_default" }),
  ensureDefaultApplications: async () => {},
}));

const { requestId } = await import("../../middleware/request-id.ts");
const { errorHandler } = await import("../../middleware/error-handler.ts");
const { createApplicationsRouter } = await import("../applications.ts");

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
app.route("/api/applications", createApplicationsRouter());

function jsonRequest(path: string, method: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

beforeEach(() => {
  mockCreateResult = {};
  mockCreateThrow = null;
  mockListResult = [];
  mockGetResult = {};
  mockGetThrow = null;
  mockUpdateResult = {};
  mockUpdateThrow = null;
  mockDeleteThrow = null;
});

// ---------------------------------------------------------------------------
// POST /api/applications
// ---------------------------------------------------------------------------

describe("POST /api/applications", () => {
  test("creates application and returns object with 201", async () => {
    mockCreateResult = {
      id: "app_abc123",
      name: "My App",
      isDefault: false,
      settings: {},
      orgId: "org-1",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };

    const res = await jsonRequest("/api/applications", "POST", {
      name: "My App",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { object: string; id: string; name: string };
    expect(json.object).toBe("application");
    expect(json.id).toBe("app_abc123");
    expect(json.name).toBe("My App");
  });

  test("validates name is required — rejects empty body with 400", async () => {
    const res = await jsonRequest("/api/applications", "POST", {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("invalid_request");
  });

  test("validates name is not empty string with 400", async () => {
    const res = await jsonRequest("/api/applications", "POST", { name: "" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("invalid_request");
  });

  test("validates name max length with 400", async () => {
    const res = await jsonRequest("/api/applications", "POST", {
      name: "a".repeat(101),
    });
    expect(res.status).toBe(400);
  });

  test("accepts optional settings", async () => {
    mockCreateResult = {
      id: "app_with_settings",
      name: "Configured",
      isDefault: false,
      settings: { theme: "dark" },
      orgId: "org-1",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };

    const res = await jsonRequest("/api/applications", "POST", {
      name: "Configured",
      settings: { theme: "dark" },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { settings: { theme: string } };
    expect(json.settings).toEqual({ theme: "dark" });
  });
});

// ---------------------------------------------------------------------------
// GET /api/applications
// ---------------------------------------------------------------------------

describe("GET /api/applications", () => {
  test("returns list of applications", async () => {
    mockListResult = [
      {
        id: "app_1",
        name: "App One",
        isDefault: true,
        settings: {},
        orgId: "org-1",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
      {
        id: "app_2",
        name: "App Two",
        isDefault: false,
        settings: {},
        orgId: "org-1",
        createdAt: new Date("2026-01-02"),
        updatedAt: new Date("2026-01-02"),
      },
    ];

    const res = await app.request("/api/applications");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object: string; data: { object: string; id: string }[] };
    expect(json.object).toBe("list");
    expect(json.data).toHaveLength(2);
    expect(json.data[0]!.object).toBe("application");
    expect(json.data[0]!.id).toBe("app_1");
  });

  test("returns empty list when no applications exist", async () => {
    mockListResult = [];

    const res = await app.request("/api/applications");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object: string; data: unknown[] };
    expect(json.object).toBe("list");
    expect(json.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/applications/:id
// ---------------------------------------------------------------------------

describe("GET /api/applications/:id", () => {
  test("returns a single application", async () => {
    mockGetResult = {
      id: "app_abc",
      name: "My App",
      isDefault: false,
      settings: {},
      orgId: "org-1",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };

    const res = await app.request("/api/applications/app_abc");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object: string; id: string };
    expect(json.object).toBe("application");
    expect(json.id).toBe("app_abc");
  });

  test("returns 404 for unknown application id", async () => {
    mockGetThrow = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "Application not found",
    });

    const res = await app.request("/api/applications/app_unknown");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/applications/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/applications/:id", () => {
  test("updates application name", async () => {
    mockUpdateResult = {
      id: "app_abc",
      name: "Renamed",
      isDefault: false,
      settings: {},
      orgId: "org-1",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
    };

    const res = await jsonRequest("/api/applications/app_abc", "PATCH", {
      name: "Renamed",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object: string; name: string };
    expect(json.object).toBe("application");
    expect(json.name).toBe("Renamed");
  });

  test("updates application settings", async () => {
    mockUpdateResult = {
      id: "app_abc",
      name: "My App",
      isDefault: false,
      settings: { theme: "light" },
      orgId: "org-1",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
    };

    const res = await jsonRequest("/api/applications/app_abc", "PATCH", {
      settings: { theme: "light" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { settings: { theme: string } };
    expect(json.settings).toEqual({ theme: "light" });
  });

  test("returns 404 for unknown application id", async () => {
    mockUpdateThrow = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "Application not found",
    });

    const res = await jsonRequest("/api/applications/app_unknown", "PATCH", {
      name: "Nope",
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("not_found");
  });

  test("rejects empty name string with 400", async () => {
    const res = await jsonRequest("/api/applications/app_abc", "PATCH", {
      name: "",
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/applications/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/applications/:id", () => {
  test("deletes application and returns 204", async () => {
    const res = await app.request("/api/applications/app_abc", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  test("returns 400 when trying to delete default application", async () => {
    mockDeleteThrow = new ApiError({
      status: 400,
      code: "invalid_request",
      title: "Invalid Request",
      detail: "Cannot delete default application",
    });

    const res = await app.request("/api/applications/app_default", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string; detail: string };
    expect(json.code).toBe("invalid_request");
    expect(json.detail).toContain("Cannot delete default application");
  });

  test("returns 404 for unknown application id", async () => {
    mockDeleteThrow = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "Application not found",
    });

    const res = await app.request("/api/applications/app_unknown", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("not_found");
  });
});
