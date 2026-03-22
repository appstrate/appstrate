/**
 * Tests for the Appstrate-User header middleware logic.
 *
 * The middleware is inline in index.ts, so we replicate the relevant logic
 * in a standalone Hono app to test the header resolution behavior in isolation.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/index.ts";
import { ApiError } from "../../lib/errors.ts";

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

// --- Controllable mock for isEndUserInApp ---

let mockIsEndUserInAppResult: {
  id: string;
  applicationId: string;
  name: string | null;
  email: string | null;
} | null = null;

mock.module("../../services/end-users.ts", () => ({
  isEndUserInApp: async () => mockIsEndUserInAppResult,
  createEndUser: async () => ({}),
  listEndUsers: async () => ({ object: "list", data: [], hasMore: false, limit: 20 }),
  getEndUser: async () => ({}),
  updateEndUser: async () => ({}),
  deleteEndUser: async () => {},
  validateMetadata: () => ({ valid: true, data: {} }),
  findByExternalId: async () => null,
}));

const { isEndUserInApp } = await import("../../services/end-users.ts");

const { requestId } = await import("../../middleware/request-id.ts");
const { errorHandler } = await import("../../middleware/error-handler.ts");

/**
 * Build a minimal Hono app that replicates the Appstrate-User middleware logic.
 * This mirrors the inline middleware from index.ts lines 144-201.
 */
function buildTestApp(authMethod: "api_key" | "session") {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", requestId());

  // Simulate auth — set user context based on authMethod
  app.use("*", async (c, next) => {
    c.set("user", { id: "user-1", email: "test@test.com", name: "Test" });
    c.set("orgId", "org-1");
    c.set("orgSlug", "test-org");
    c.set("orgRole", "admin");
    c.set("authMethod", authMethod);
    if (authMethod === "api_key") {
      c.set("applicationId", "app_test");
    }

    // Replicate Appstrate-User header logic from index.ts
    const targetEndUserId = c.req.header("Appstrate-User");

    if (targetEndUserId && authMethod === "session") {
      // Cookie auth does not allow Appstrate-User header
      throw new ApiError({
        status: 400,
        code: "header_not_allowed",
        title: "Header Not Allowed",
        detail: "Appstrate-User header is not allowed with cookie authentication",
        param: "Appstrate-User",
      });
    }

    if (targetEndUserId && authMethod === "api_key") {
      if (!targetEndUserId.startsWith("eu_")) {
        throw new ApiError({
          status: 400,
          code: "invalid_end_user_id",
          title: "Invalid End-User ID",
          detail: `Appstrate-User header must be an end-user ID with 'eu_' prefix, got '${targetEndUserId}'`,
          param: "Appstrate-User",
        });
      }
      const endUser = await isEndUserInApp("app_test", targetEndUserId);
      if (!endUser) {
        throw new ApiError({
          status: 403,
          code: "invalid_end_user",
          title: "Invalid End-User",
          detail: `End-user '${targetEndUserId}' does not exist or does not belong to this application`,
          param: "Appstrate-User",
        });
      }
      c.set("endUser", endUser);
    }

    await next();
  });

  // Simple test route that returns context info
  app.get("/api/test", (c) => {
    const endUser = c.get("endUser");
    return c.json({
      hasEndUser: !!endUser,
      endUser: endUser ?? null,
    });
  });

  return app;
}

beforeEach(() => {
  mockIsEndUserInAppResult = null;
});

// ---------------------------------------------------------------------------
// API Key auth + Appstrate-User header
// ---------------------------------------------------------------------------

describe("Appstrate-User header with API key auth", () => {
  const app = buildTestApp("api_key");

  test("valid eu_ prefix sets endUser in context", async () => {
    mockIsEndUserInAppResult = {
      id: "eu_abc123",
      applicationId: "app_default",
      name: "John",
      email: "john@example.com",
    };

    const res = await app.request("/api/test", {
      headers: { "Appstrate-User": "eu_abc123" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      hasEndUser: boolean;
      endUser: { id: string; applicationId: string };
    };
    expect(json.hasEndUser).toBe(true);
    expect(json.endUser.id).toBe("eu_abc123");
    expect(json.endUser.applicationId).toBe("app_default");
  });

  test("missing eu_ prefix returns 400 invalid_end_user_id", async () => {
    const res = await app.request("/api/test", {
      headers: { "Appstrate-User": "user-123" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string; param: string };
    expect(json.code).toBe("invalid_end_user_id");
    expect(json.param).toBe("Appstrate-User");
  });

  test("unknown eu_ id returns 403 invalid_end_user", async () => {
    mockIsEndUserInAppResult = null;

    const res = await app.request("/api/test", {
      headers: { "Appstrate-User": "eu_nonexistent" },
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { code: string; param: string };
    expect(json.code).toBe("invalid_end_user");
    expect(json.param).toBe("Appstrate-User");
  });

  test("no Appstrate-User header leaves endUser undefined", async () => {
    const res = await app.request("/api/test");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { hasEndUser: boolean; endUser: null };
    expect(json.hasEndUser).toBe(false);
    expect(json.endUser).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cookie auth + Appstrate-User header
// ---------------------------------------------------------------------------

describe("Appstrate-User header with cookie auth", () => {
  const app = buildTestApp("session");

  test("rejects Appstrate-User header with 400 header_not_allowed", async () => {
    const res = await app.request("/api/test", {
      headers: { "Appstrate-User": "eu_abc123" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string; param: string };
    expect(json.code).toBe("header_not_allowed");
    expect(json.param).toBe("Appstrate-User");
  });

  test("no Appstrate-User header works normally", async () => {
    const res = await app.request("/api/test");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { hasEndUser: boolean };
    expect(json.hasEndUser).toBe(false);
  });
});
