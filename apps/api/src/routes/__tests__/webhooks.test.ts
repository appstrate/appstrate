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

// --- Controllable mock state ---

let mockCreateResult: unknown = {};
let mockListResult: unknown[] = [];
let mockGetResult: unknown = {};
let mockGetThrow: ApiError | null = null;
let mockCreateThrow: ApiError | null = null;
let mockRotateResult = { secret: "whsec_new" };
let mockDeliveries: unknown[] = [];

mock.module("../../services/webhooks.ts", () => ({
  createWebhook: async () => {
    if (mockCreateThrow) throw mockCreateThrow;
    return mockCreateResult;
  },
  listWebhooks: async () => mockListResult,
  getWebhook: async () => {
    if (mockGetThrow) throw mockGetThrow;
    return mockGetResult;
  },
  updateWebhook: async () => {
    if (mockGetThrow) throw mockGetThrow;
    return mockGetResult;
  },
  deleteWebhook: async () => {
    if (mockGetThrow) throw mockGetThrow;
  },
  rotateSecret: async () => {
    if (mockGetThrow) throw mockGetThrow;
    return mockRotateResult;
  },
  listDeliveries: async () => {
    if (mockGetThrow) throw mockGetThrow;
    return mockDeliveries;
  },
  buildEventEnvelope: () => ({
    eventId: "evt_test",
    payload: { id: "evt_test", object: "event", type: "test.ping" },
  }),
  buildSignedHeaders: async () => ({
    "webhook-id": "evt_test",
    "webhook-timestamp": "123",
    "webhook-signature": "v1,test",
  }),
  validateWebhookUrl: () => {},
  validateEvents: (events: unknown) => events,
  dispatchWebhookEvents: async () => {},
  initWebhookWorker: () => {},
  shutdownWebhookWorker: async () => {},
}));

const { requestId } = await import("../../middleware/request-id.ts");
const { errorHandler } = await import("../../middleware/error-handler.ts");
const { createWebhooksRouter } = await import("../webhooks.ts");

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
app.route("/api/webhooks", createWebhooksRouter());

function jsonRequest(path: string, method: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

beforeEach(() => {
  resetQueues();
  mockCreateResult = {};
  mockListResult = [];
  mockGetResult = {};
  mockGetThrow = null;
  mockCreateThrow = null;
  mockRotateResult = { secret: "whsec_new" };
  mockDeliveries = [];
});

describe("POST /api/webhooks", () => {
  test("creates webhook → 201 with secret", async () => {
    mockCreateResult = {
      id: "wh_abc",
      object: "webhook",
      url: "https://example.com/hook",
      events: ["execution.completed"],
      flowId: null,
      payloadMode: "full",
      active: true,
      secret: "whsec_test123",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const res = await jsonRequest("/api/webhooks", "POST", {
      url: "https://example.com/hook",
      events: ["execution.completed"],
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; object: string; secret: string };
    expect(json.object).toBe("webhook");
    expect(json.secret).toBe("whsec_test123");
  });

  test("rejects missing url → 400", async () => {
    const res = await jsonRequest("/api/webhooks", "POST", {
      events: ["execution.completed"],
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing events → 400", async () => {
    const res = await jsonRequest("/api/webhooks", "POST", {
      url: "https://example.com/hook",
    });
    expect(res.status).toBe(400);
  });

  test("rejects webhook limit → 400", async () => {
    mockCreateThrow = new ApiError({
      status: 400,
      code: "webhook_limit_reached",
      title: "Webhook Limit Reached",
      detail: "Maximum 20 webhooks per organization",
    });

    const res = await jsonRequest("/api/webhooks", "POST", {
      url: "https://example.com/hook",
      events: ["execution.completed"],
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("webhook_limit_reached");
  });
});

describe("GET /api/webhooks", () => {
  test("returns list", async () => {
    mockListResult = [
      {
        id: "wh_1",
        object: "webhook",
        url: "https://a.com",
        events: ["execution.completed"],
        active: true,
      },
    ];

    const res = await app.request("/api/webhooks");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object: string; data: unknown[] };
    expect(json.object).toBe("list");
    expect(json.data).toHaveLength(1);
  });
});

describe("GET /api/webhooks/:id", () => {
  test("returns webhook", async () => {
    mockGetResult = {
      id: "wh_abc",
      object: "webhook",
      url: "https://a.com",
      events: ["execution.completed"],
      active: true,
    };

    const res = await app.request("/api/webhooks/wh_abc");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string };
    expect(json.id).toBe("wh_abc");
  });

  test("404 for unknown webhook", async () => {
    mockGetThrow = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "Webhook not found",
    });

    const res = await app.request("/api/webhooks/wh_unknown");
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/webhooks/:id", () => {
  test("updates webhook", async () => {
    mockGetResult = {
      id: "wh_abc",
      object: "webhook",
      url: "https://new.com",
      events: ["execution.failed"],
      active: false,
    };

    const res = await jsonRequest("/api/webhooks/wh_abc", "PUT", {
      url: "https://new.com",
      active: false,
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/webhooks/:id", () => {
  test("deletes → 204", async () => {
    const res = await app.request("/api/webhooks/wh_abc", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  test("404 for unknown", async () => {
    mockGetThrow = new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: "Webhook not found",
    });

    const res = await app.request("/api/webhooks/wh_unknown", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/webhooks/:id/rotate", () => {
  test("rotates secret", async () => {
    const res = await jsonRequest("/api/webhooks/wh_abc/rotate", "POST");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { secret: string };
    expect(json.secret).toBe("whsec_new");
  });
});

describe("GET /api/webhooks/:id/deliveries", () => {
  test("returns delivery history", async () => {
    mockDeliveries = [
      {
        id: "d1",
        eventId: "evt_1",
        eventType: "execution.completed",
        status: "success",
        statusCode: 200,
        latency: 150,
        attempt: 1,
      },
    ];

    const res = await app.request("/api/webhooks/wh_abc/deliveries");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object: string; data: unknown[] };
    expect(json.object).toBe("list");
    expect(json.data).toHaveLength(1);
  });
});
