import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/index.ts";
import { requestId } from "../request-id.ts";
import { errorHandler } from "../error-handler.ts";
import {
  ApiError,
  invalidRequest,
  forbidden,
  notFound,
  unauthorized,
  conflict,
  gone,
} from "../../lib/errors.ts";

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", requestId());
  return app;
}

describe("errorHandler middleware", () => {
  test("catches ApiError and returns application/problem+json", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw invalidRequest("Missing name field", "name");
    });

    const res = await app.request("/test");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe("https://docs.appstrate.dev/errors/invalid-request");
    expect(body.title).toBe("Invalid Request");
    expect(body.status).toBe(400);
    expect(body.detail).toBe("Missing name field");
    expect(body.code).toBe("invalid_request");
    expect(body.param).toBe("name");
    expect(typeof body.requestId).toBe("string");
    expect((body.requestId as string).startsWith("req_")).toBe(true);
    expect((body.instance as string).startsWith("urn:appstrate:request:req_")).toBe(true);
  });

  test("errors array via ApiError constructor", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw new ApiError({
        status: 400,
        code: "validation_failed",
        title: "Validation Failed",
        detail: "Request validation failed.",
        errors: [
          { field: "name", code: "required", message: "Name is required." },
          { field: "email", code: "invalid_format", message: "Invalid email." },
        ],
      });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("validation_failed");
    expect(Array.isArray(body.errors)).toBe(true);
    const errors = body.errors as { field: string; code: string; message: string }[];
    expect(errors).toHaveLength(2);
    expect(errors[0]!.field).toBe("name");
    expect(errors[1]!.field).toBe("email");
  });

  test("unauthorized returns 401", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw unauthorized("Invalid API key");
    });

    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("unauthorized");
  });

  test("forbidden returns 403", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw forbidden("Admin access required");
    });

    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("forbidden");
  });

  test("notFound returns 404", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw notFound("User not found");
    });

    const res = await app.request("/test");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("not_found");
  });

  test("conflict returns 409 with custom code", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw conflict("flow_in_use", "Flow has running executions");
    });

    const res = await app.request("/test");
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("flow_in_use");
  });

  test("gone returns 410 with custom code", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw gone("token_invalid", "This link is no longer valid.");
    });

    const res = await app.request("/test");
    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("token_invalid");
  });

  test("retryAfter field included when set", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw new ApiError({
        status: 429,
        code: "rate_limited",
        title: "Rate Limited",
        detail: "Too many requests.",
        retryAfter: 30,
      });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.retryAfter).toBe(30);
  });

  test("unhandled errors become 500 internal_error", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw new Error("something broke");
    });

    const res = await app.request("/test");
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("internal_error");
    expect(body.detail).not.toContain("something broke");
  });

  test("type URI uses kebab-case from code", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw new ApiError({
        status: 400,
        code: "webhook_url_invalid",
        title: "Webhook URL Invalid",
        detail: "test",
      });
    });

    const res = await app.request("/test");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe("https://docs.appstrate.dev/errors/webhook-url-invalid");
  });

  test("requestId in body matches Request-Id header", async () => {
    const app = createApp();
    app.get("/test", () => {
      throw invalidRequest("test");
    });

    const res = await app.request("/test");
    const header = res.headers.get("Request-Id");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.requestId).toBe(header);
  });
});
