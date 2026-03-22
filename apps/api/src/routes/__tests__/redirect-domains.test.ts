import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/index.ts";
import { queues, resetQueues, db, schemaStubs } from "../../services/__tests__/_db-mock.ts";

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));

mock.module("@appstrate/db/schema", () => schemaStubs);

mock.module("../../lib/cloud-loader.ts", () => ({
  getCloudModule: () => null,
}));

mock.module("../../services/invitations.ts", () => ({
  createInvitation: async () => ({}),
  getOrgInvitations: async () => [],
  cancelInvitation: async () => {},
  updateInvitationRole: async () => null,
  getInvitationByToken: async () => null,
  markInvitationAccepted: async () => {},
  getOrgName: async () => "Test Org",
  getInviterName: async () => "Test User",
}));

mock.module("../../services/default-flow.ts", () => ({
  provisionDefaultFlowForOrg: async () => {},
}));

const { requestId } = await import("../../middleware/request-id.ts");
const { errorHandler } = await import("../../middleware/error-handler.ts");
const orgsModule = await import("../organizations.ts");

// Test app — includes error handler + request-id to match production pipeline
const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.use("*", requestId());
app.use("*", async (c, next) => {
  c.set("user" as never, { id: "user-1", email: "test@test.com", name: "Test" } as never);
  await next();
});
app.route("/api/orgs", orgsModule.default);

function jsonRequest(path: string, method: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

beforeEach(() => resetQueues());

describe("GET /api/orgs/:orgId/settings/redirect-domains", () => {
  test("returns domains for admin", async () => {
    queues.select.push([{ role: "admin", userId: "user-1" }]);
    queues.select.push([{ allowedRedirectDomains: ["myapp.com", "staging.myapp.com"] }]);

    const res = await app.request("/api/orgs/org-1/settings/redirect-domains");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { allowedRedirectDomains: string[] };
    expect(json.allowedRedirectDomains).toEqual(["myapp.com", "staging.myapp.com"]);
  });

  test("returns empty array when no domains configured", async () => {
    queues.select.push([{ role: "owner", userId: "user-1" }]);
    queues.select.push([{ allowedRedirectDomains: null }]);

    const res = await app.request("/api/orgs/org-1/settings/redirect-domains");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { allowedRedirectDomains: string[] };
    expect(json.allowedRedirectDomains).toEqual([]);
  });

  test("rejects non-admin with RFC 9457 error", async () => {
    queues.select.push([{ role: "member", userId: "user-1" }]);

    const res = await app.request("/api/orgs/org-1/settings/redirect-domains");
    expect(res.status).toBe(403);
    const json = (await res.json()) as { code: string; detail: string };
    expect(json.code).toBe("forbidden");
    expect(json.detail).toBe("Admin access required");
  });

  test("rejects non-member", async () => {
    queues.select.push([]);

    const res = await app.request("/api/orgs/org-1/settings/redirect-domains");
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/orgs/:orgId/settings/redirect-domains", () => {
  test("sets domains for admin", async () => {
    queues.select.push([{ role: "admin", userId: "user-1" }]);
    queues.update.push([{ allowedRedirectDomains: ["newapp.com"] }]);

    const res = await jsonRequest("/api/orgs/org-1/settings/redirect-domains", "PUT", {
      allowedRedirectDomains: ["newapp.com"],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { allowedRedirectDomains: string[] };
    expect(json.allowedRedirectDomains).toEqual(["newapp.com"]);
  });

  test("rejects missing allowedRedirectDomains", async () => {
    queues.select.push([{ role: "admin", userId: "user-1" }]);

    const res = await jsonRequest("/api/orgs/org-1/settings/redirect-domains", "PUT", {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("invalid_request");
  });

  test("rejects invalid domain format", async () => {
    queues.select.push([{ role: "admin", userId: "user-1" }]);

    const res = await jsonRequest("/api/orgs/org-1/settings/redirect-domains", "PUT", {
      allowedRedirectDomains: ["https://not-a-domain.com"],
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { detail: string };
    expect(json.detail).toContain("Invalid domain");
  });

  test("rejects more than 20 domains", async () => {
    queues.select.push([{ role: "admin", userId: "user-1" }]);
    const domains = Array.from({ length: 21 }, (_, i) => `domain${i}.com`);

    const res = await jsonRequest("/api/orgs/org-1/settings/redirect-domains", "PUT", {
      allowedRedirectDomains: domains,
    });
    expect(res.status).toBe(400);
  });

  test("accepts empty list (clear all domains)", async () => {
    queues.select.push([{ role: "owner", userId: "user-1" }]);
    queues.update.push([{ allowedRedirectDomains: [] }]);

    const res = await jsonRequest("/api/orgs/org-1/settings/redirect-domains", "PUT", {
      allowedRedirectDomains: [],
    });
    expect(res.status).toBe(200);
  });

  test("rejects non-admin", async () => {
    queues.select.push([{ role: "member", userId: "user-1" }]);

    const res = await jsonRequest("/api/orgs/org-1/settings/redirect-domains", "PUT", {
      allowedRedirectDomains: ["myapp.com"],
    });
    expect(res.status).toBe(403);
  });
});
