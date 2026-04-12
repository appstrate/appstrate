// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI response validation for webhook routes.
 *
 * Assembles the OpenAPI spec with the webhooks module contributions and
 * validates that live responses conform to it. Lives in the module so core
 * tests running alone have zero knowledge of the webhooks OpenAPI bundle.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { createOpenApiValidator } from "../../../../../../test/helpers/openapi-validator.ts";
import { buildOpenApiSpec } from "../../../../../openapi/index.ts";
import { seedWebhook } from "../../helpers/seed.ts";
import webhooksModule from "../../../index.ts";

const openApiSpec = buildOpenApiSpec(
  webhooksModule.openApiPaths?.() ?? {},
  webhooksModule.openApiComponentSchemas?.() ?? {},
  webhooksModule.openApiTags?.() ?? [],
);
const { getResponseSchema, validateResponse } = createOpenApiValidator(openApiSpec);

const app = getTestApp();

describe("OpenAPI response validation — webhooks", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "openapi-webhooks" });
  });

  describe("POST /api/webhooks -> 201", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/webhooks", "POST", "201");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "application",
          applicationId: ctx.defaultAppId,
          url: "https://example.com/hook",
          events: ["run.success"],
        }),
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("POST /api/webhooks 201 validation errors:", result.errors);
      }

      expect(result.valid).toBe(true);
    });
  });

  describe("GET /api/webhooks -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/webhooks", "GET", "200");
      expect(schema).not.toBeNull();

      await seedWebhook({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });

      const res = await app.request(`/api/webhooks?applicationId=${ctx.defaultAppId}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/webhooks 200 validation errors:", result.errors);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("data");
      expect((body as any).data).toBeArray();
      expect((body as any).data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /api/webhooks/{id} -> 200", () => {
    it("response body conforms to OpenAPI schema", async () => {
      const schema = getResponseSchema("/api/webhooks/{id}", "GET", "200");
      expect(schema).not.toBeNull();

      const wh = await seedWebhook({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });

      const res = await app.request(`/api/webhooks/${wh.id}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("GET /api/webhooks/{id} 200 validation errors:", result.errors);
      }

      expect(result.valid).toBe(true);
      expect((body as any).id).toBe(wh.id);
    });
  });

  describe("POST /api/webhooks -> 400 (invalid body)", () => {
    it("error response conforms to ProblemDetail schema", async () => {
      const schema = getResponseSchema("/api/webhooks", "POST", "400");
      expect(schema).not.toBeNull();

      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ url: "not-a-url" }),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      const result = validateResponse(body, schema);

      if (!result.valid) {
        console.error("POST /api/webhooks 400 validation errors:", result.errors);
      }

      expect(result.valid).toBe(true);
      expect(body).toHaveProperty("status");
      expect((body as any).status).toBe(400);
    });
  });
});
