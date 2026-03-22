/**
 * Tests for the Appstrate-User header resolution in the auth middleware.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/index.ts";
import { resetQueues, db, schemaStubs } from "../../services/__tests__/_db-mock.ts";

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));
mock.module("@appstrate/db/schema", () => schemaStubs);

// Mock API key validation
let mockKeyInfo: {
  keyId: string;
  userId: string;
  email: string;
  name: string;
  orgId: string;
  orgSlug: string;
} | null = null;

mock.module("../../services/api-keys.ts", () => ({
  validateApiKey: async (rawKey: string) => (rawKey === "ask_valid_key" ? mockKeyInfo : null),
}));

// Mock session auth
let mockSession: { user?: { id: string; email: string; name: string } } | null = null;

mock.module("../../lib/auth.ts", () => ({
  auth: {
    api: { getSession: async () => mockSession },
    handler: async () => new Response("ok"),
  },
}));

mock.module("../../services/connection-profiles.ts", () => ({
  ensureDefaultProfile: async () => ({}),
  listProfiles: async () => [],
  getProfileForUser: async () => null,
  createProfile: async () => ({}),
  renameProfile: async () => {},
  deleteProfile: async () => {},
  getDefaultProfileId: async () => "default",
  getEffectiveProfileId: async () => "default",
  setPackageProfileOverride: async () => {},
  removePackageProfileOverride: async () => {},
  resolveProviderProfiles: async () => ({}),
}));

// Mock isOrgMember
let mockOrgMember: { id: string; email: string; name: string } | null = null;

mock.module("../../services/users.ts", () => ({
  isOrgMember: async () => mockOrgMember,
  createUser: async () => ({}),
  listUsers: async () => ({ object: "list", data: [], hasMore: false, limit: 20 }),
  getUser: async () => ({}),
  updateUser: async () => ({}),
  deleteUser: async () => {},
  validateMetadata: () => ({ valid: true, data: {} }),
}));

// Dynamic imports (after mocks)
const { requestId } = await import("../request-id.ts");
const { errorHandler } = await import("../error-handler.ts");
const { ApiError, unauthorized } = await import("../../lib/errors.ts");
const { validateApiKey } = await import("../../services/api-keys.ts");
const { auth } = await import("../../lib/auth.ts");
const { isOrgMember } = await import("../../services/users.ts");

// --- Test app (replicates auth middleware from index.ts) ---

function createTestApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", requestId());

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader?.startsWith("Bearer ask_")) {
      const rawKey = authHeader.slice(7);
      const keyInfo = await validateApiKey(rawKey);
      if (!keyInfo) throw unauthorized("Invalid or expired API key");

      c.set("user", { id: keyInfo.userId, email: keyInfo.email, name: keyInfo.name });
      c.set("orgId", keyInfo.orgId);
      c.set("orgSlug", keyInfo.orgSlug);
      c.set("orgRole", "admin");
      c.set("authMethod", "api_key");
      c.set("apiKeyId", keyInfo.keyId);

      const targetUserId = c.req.header("Appstrate-User");
      if (targetUserId) {
        const targetUser = await isOrgMember(keyInfo.orgId, targetUserId);
        if (!targetUser) {
          throw new ApiError({
            status: 403,
            code: "invalid_user",
            title: "Invalid User",
            detail: `User '${targetUserId}' does not exist or is not a member of this organization`,
            param: "Appstrate-User",
          });
        }
        c.set("user", { id: targetUser.id, email: targetUser.email, name: targetUser.name });
      }

      return next();
    }

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) throw unauthorized("Invalid or missing session");

    if (c.req.header("Appstrate-User")) {
      throw new ApiError({
        status: 400,
        code: "header_not_allowed",
        title: "Header Not Allowed",
        detail: "Appstrate-User header is not allowed with cookie authentication",
        param: "Appstrate-User",
      });
    }

    c.set("user", { id: session.user.id, email: session.user.email, name: session.user.name });
    c.set("authMethod", "session");
    return next();
  });

  app.get("/api/whoami", (c) => c.json({ user: c.get("user"), authMethod: c.get("authMethod") }));

  return app;
}

// --- Tests ---

beforeEach(() => {
  resetQueues();
  mockKeyInfo = {
    keyId: "key-1",
    userId: "admin-1",
    email: "admin@test.com",
    name: "Admin",
    orgId: "org-1",
    orgSlug: "test",
  };
  mockSession = null;
  mockOrgMember = null;
});

describe("Appstrate-User header", () => {
  describe("with API key auth", () => {
    test("without header → uses API key owner", async () => {
      const app = createTestApp();
      const res = await app.request("/api/whoami", {
        headers: { Authorization: "Bearer ask_valid_key" },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { user: { id: string }; authMethod: string };
      expect(json.user.id).toBe("admin-1");
      expect(json.authMethod).toBe("api_key");
    });

    test("with valid header → replaces user context", async () => {
      mockOrgMember = { id: "usr_target", email: "target@test.com", name: "Target" };

      const app = createTestApp();
      const res = await app.request("/api/whoami", {
        headers: {
          Authorization: "Bearer ask_valid_key",
          "Appstrate-User": "usr_target",
        },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { user: { id: string; name: string } };
      expect(json.user.id).toBe("usr_target");
      expect(json.user.name).toBe("Target");
    });

    test("with invalid user → 403 invalid_user", async () => {
      mockOrgMember = null;

      const app = createTestApp();
      const res = await app.request("/api/whoami", {
        headers: {
          Authorization: "Bearer ask_valid_key",
          "Appstrate-User": "usr_nonexistent",
        },
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as { code: string; param: string };
      expect(json.code).toBe("invalid_user");
      expect(json.param).toBe("Appstrate-User");
    });
  });

  describe("with cookie session auth", () => {
    test("without header → normal session behavior", async () => {
      mockKeyInfo = null;
      mockSession = { user: { id: "session-user", email: "user@test.com", name: "User" } };

      const app = createTestApp();
      const res = await app.request("/api/whoami");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { user: { id: string }; authMethod: string };
      expect(json.user.id).toBe("session-user");
      expect(json.authMethod).toBe("session");
    });

    test("with header → 400 header_not_allowed", async () => {
      mockKeyInfo = null;
      mockSession = { user: { id: "session-user", email: "user@test.com", name: "User" } };

      const app = createTestApp();
      const res = await app.request("/api/whoami", {
        headers: { "Appstrate-User": "usr_target" },
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { code: string; param: string };
      expect(json.code).toBe("header_not_allowed");
      expect(json.param).toBe("Appstrate-User");
    });
  });
});
