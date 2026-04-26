// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI response validation tests.
 *
 * Validates that actual API responses conform to the OpenAPI 3.1 specification.
 * Uses AJV to validate response bodies against the schemas defined in the spec.
 *
 * These tests catch drift between the implementation and the spec — when a route
 * returns fields not documented in the spec, or omits required fields, or returns
 * the wrong type for a field.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedEndUser, seedApiKey } from "../../helpers/seed.ts";
import { buildOpenApiSpec } from "../../../src/openapi/index.ts";
import { createOpenApiValidator } from "../../helpers/openapi-validator.ts";

// Core-only OpenAPI spec. Module routes (e.g. webhooks) are validated in
// their respective module test suites with their own spec bundles.
const openApiSpec = buildOpenApiSpec();
const { getResponseSchema, validateResponse, dereference } = createOpenApiValidator(openApiSpec);

const app = getTestApp();

// ─── Tests ──────────────────────────────────────────────────────

describe("OpenAPI response validation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "openapi-test" });
  });

  // ── Health (no auth) ───────────────────────────────────────

  describe("GET /health -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/health", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /health validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /health extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
    });
  });

  // ── Agents list (auth + app-scoped) ────────────────────────

  describe("GET /api/agents -> 200 (empty list)", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/agents", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/agents validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /api/agents extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("object", "list");
      expect(body).toHaveProperty("data");
      expect((body as any).data).toBeArray();
    });
  });

  // ── Agents list 401 (no auth) ─────────────────────────────

  describe("GET /api/agents -> 401 (unauthenticated)", () => {
    it("error response conforms to ProblemDetail schema", async () => {
      const schema = getResponseSchema("/api/agents", "GET", "401");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/agents");
      expect(res.status).toBe(401);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/agents 401 validation errors:", result.errors);
        console.error("Missing required fields:", result.missingRequiredFields);
      }

      expect(result.valid).toBe(true);
      // ProblemDetail should have these fields
      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("code");
    });
  });

  // ── Applications list (auth + org-scoped) ──────────────────

  describe("GET /api/applications -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/applications", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/applications", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/applications validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /api/applications extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("object");
      expect((body as any).object).toBe("list");
      expect(body).toHaveProperty("data");
      expect((body as any).data).toBeArray();
    });

    it("each application item conforms to ApplicationObject schema", async () => {
      const appSchema = dereference((openApiSpec as any).components.schemas.ApplicationObject);
      expect(appSchema).toBeDefined();

      const res = await app.request("/api/applications", {
        headers: authHeaders(ctx),
      });
      const body = (await res.json()) as any;

      // At least the default app from createTestContext
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      for (const item of body.data) {
        const result = validateResponse(item, appSchema);
        if (!result.valid) {
          console.error(`ApplicationObject validation errors for ${item.id}:`, result.errors);
        }
        if (result.extraFields.length > 0) {
          console.warn(`ApplicationObject extra fields for ${item.id}:`, result.extraFields);
        }
        expect(result.valid).toBe(true);
      }
    });
  });

  // ── Organizations list (auth, no org/app header needed) ────

  describe("GET /api/orgs -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/orgs", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/orgs", {
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/orgs validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /api/orgs extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("data");
      expect((body as any).data).toBeArray();
      expect((body as any).data.length).toBeGreaterThanOrEqual(1);
    });

    it("each organization item conforms to Organization schema", async () => {
      const orgSchema = dereference((openApiSpec as any).components.schemas.Organization);
      expect(orgSchema).toBeDefined();

      const res = await app.request("/api/orgs", {
        headers: { Cookie: ctx.cookie },
      });
      const body = (await res.json()) as any;

      for (const org of body.data) {
        const result = validateResponse(org, orgSchema);
        if (!result.valid) {
          console.error(`Organization validation errors for ${org.id}:`, result.errors);
        }
        if (result.extraFields.length > 0) {
          console.warn(`Organization extra fields for ${org.id}:`, result.extraFields);
        }
        expect(result.valid).toBe(true);
      }
    });
  });

  // ── Profile (auth, no org/app header needed) ───────────────

  describe("GET /api/profile -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/profile", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/profile", {
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/profile validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /api/profile extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("id");
    });
  });

  // ── Notifications unread count (auth + app-scoped) ─────────

  describe("GET /api/notifications/unread-count -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/notifications/unread-count", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/notifications/unread-count", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/notifications/unread-count validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn(
          "GET /api/notifications/unread-count extra fields not in spec:",
          result.extraFields,
        );
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("count");
      expect(typeof (body as any).count).toBe("number");
    });
  });

  // ── Notifications unread counts by agent (auth + app-scoped) ─

  describe("GET /api/notifications/unread-counts-by-agent -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/notifications/unread-counts-by-agent", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/notifications/unread-counts-by-agent", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error(
          "GET /api/notifications/unread-counts-by-agent validation errors:",
          result.errors,
        );
      }
      if (result.extraFields.length > 0) {
        console.warn(
          "GET /api/notifications/unread-counts-by-agent extra fields not in spec:",
          result.extraFields,
        );
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("counts");
    });
  });

  // ── End-users CRUD (auth + app-scoped) ─────────────────────

  describe("POST /api/end-users -> 201", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/end-users", "POST", "201");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/end-users", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test End User",
          email: "enduser@example.com",
          externalId: "ext-123",
        }),
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("POST /api/end-users 201 validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("POST /api/end-users 201 extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
    });
  });

  describe("GET /api/end-users -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/end-users", "GET", "200");
      expect(schema).not.toBeNull();

      // Seed an end-user so the list is non-empty
      await seedEndUser({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });

      const res = await app.request("/api/end-users", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/end-users 200 validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /api/end-users 200 extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("data");
      expect((body as any).data).toBeArray();
      expect((body as any).data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /api/end-users/{id} -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/end-users/{id}", "GET", "200");
      expect(schema).not.toBeNull();

      const eu = await seedEndUser({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });

      const res = await app.request(`/api/end-users/${eu.id}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/end-users/{id} 200 validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /api/end-users/{id} 200 extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
      expect((body as any).id).toBe(eu.id);
    });
  });

  // ── Schedules list (auth + app-scoped) ─────────────────────

  describe("GET /api/schedules -> 200 (empty list)", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/schedules", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/schedules", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/schedules 200 validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /api/schedules 200 extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
      expect(body).toBeArray();
    });
  });

  // ── Models list (auth + org-scoped) ────────────────────────

  describe("GET /api/models -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/models", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/models", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/models 200 validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /api/models 200 extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("models");
      expect((body as any).models).toBeArray();
    });
  });

  // ── Proxies list (auth + org-scoped) ───────────────────────

  describe("GET /api/proxies -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/proxies", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/proxies", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/proxies 200 validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /api/proxies 200 extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("proxies");
      expect((body as any).proxies).toBeArray();
    });
  });

  // ── API Keys (auth + app-scoped) ───────────────────────────

  describe("GET /api/api-keys -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/api-keys", "GET", "200");
      expect(schema).not.toBeNull();

      // Seed an API key so the list is non-empty
      await seedApiKey({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });

      const res = await app.request("/api/api-keys", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/api-keys 200 validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /api/api-keys 200 extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("apiKeys");
      expect((body as any).apiKeys).toBeArray();
      expect((body as any).apiKeys.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("POST /api/api-keys -> 201", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/api-keys", "POST", "201");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Key" }),
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("POST /api/api-keys 201 validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("POST /api/api-keys 201 extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
    });
  });

  // ── Connection Profiles list (auth + app-scoped) ───────────

  describe("GET /api/connection-profiles -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/connection-profiles", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/connection-profiles", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/connection-profiles 200 validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn(
          "GET /api/connection-profiles 200 extra fields not in spec:",
          result.extraFields,
        );
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("profiles");
      expect((body as any).profiles).toBeArray();
    });
  });

  // ── Providers list (auth + app-scoped) ─────────────────────

  describe("GET /api/providers -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/providers", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/providers", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/providers 200 validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn("GET /api/providers 200 extra fields not in spec:", result.extraFields);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("providers");
      expect((body as any).providers).toBeArray();
    });
  });

  // ── Connections integrations list (auth + app-scoped) ──────

  describe("GET /api/connections/integrations -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/connections/integrations", "GET", "200");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/connections/integrations", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/connections/integrations 200 validation errors:", result.errors);
      }
      if (result.extraFields.length > 0) {
        console.warn(
          "GET /api/connections/integrations 200 extra fields not in spec:",
          result.extraFields,
        );
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("integrations");
      expect((body as any).integrations).toBeArray();
    });
  });

  // ── Runs 404 error response ────────────────────────────────

  describe("GET /api/runs/{id} -> 404 (not found)", () => {
    it("error response conforms to ProblemDetail schema", async () => {
      const schema = getResponseSchema("/api/runs/{id}", "GET", "404");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/runs/exec_nonexistent12345", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/runs/{id} 404 validation errors:", result.errors);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("status");
      expect((body as any).status).toBe(404);
    });
  });

  // ── Helper function tests ──────────────────────────────────

  describe("schema resolution helpers", () => {
    it("getResponseSchema returns a fully resolved schema", () => {
      const schema = getResponseSchema("/health", "GET", "200") as any;
      expect(schema).not.toBeNull();
      expect(schema.type).toBe("object");
      expect(schema.properties).toHaveProperty("status");
      expect(schema.properties).toHaveProperty("checks");
    });

    it("getResponseSchema resolves $ref in response objects", () => {
      // /api/agents GET 401 uses { $ref: "#/components/responses/Unauthorized" }
      const schema = getResponseSchema("/api/agents", "GET", "401") as any;
      expect(schema).not.toBeNull();
      expect(schema.type).toBe("object");
      expect(schema.required).toContain("status");
    });
  });
});
