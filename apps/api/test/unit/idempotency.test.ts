import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../src/types/index.ts";
import { idempotency } from "../../src/middleware/idempotency.ts";
import { requestId } from "../../src/middleware/request-id.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";
import { flushRedis } from "../helpers/redis.ts";

let callCount = 0;

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", requestId());
  app.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "t@t.com", name: "T" });
    c.set("orgId", "org-1");
    return next();
  });
  app.post("/test", idempotency(), async (c) => {
    callCount++;
    const body = await c.req.json();
    return c.json({ ok: true, name: body.name, callCount }, 201);
  });
  app.post("/test-500", idempotency(), async () => {
    callCount++;
    throw new Error("server error");
  });
  return app;
}

function post(app: Hono<AppEnv>, path: string, body: object, idempotencyKey?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("idempotency middleware", () => {
  beforeEach(async () => {
    await flushRedis();
    callCount = 0;
  });

  it("passes through when no Idempotency-Key header", async () => {
    const app = createApp();
    const res = await post(app, "/test", { name: "Alice" });
    expect(res.status).toBe(201);
    expect(callCount).toBe(1);
  });

  it("executes normally on first request with key", async () => {
    const app = createApp();
    const res = await post(app, "/test", { name: "Alice" }, "key-1");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; callCount: number };
    expect(body.ok).toBe(true);
    expect(callCount).toBe(1);
  });

  it("replays cached response on second request with same key and body", async () => {
    const app = createApp();

    const res1 = await post(app, "/test", { name: "Alice" }, "key-2");
    expect(res1.status).toBe(201);
    expect(callCount).toBe(1);

    const res2 = await post(app, "/test", { name: "Alice" }, "key-2");
    expect(res2.status).toBe(201);
    expect(res2.headers.get("Idempotent-Replayed")).toBe("true");
    expect(callCount).toBe(1); // handler NOT called again

    const body2 = (await res2.json()) as { ok: boolean; callCount: number };
    expect(body2.ok).toBe(true);
    expect(body2.callCount).toBe(1); // snapshot from first call
  });

  it("returns 422 when same key but different body", async () => {
    const app = createApp();

    await post(app, "/test", { name: "Alice" }, "key-3");

    const res2 = await post(app, "/test", { name: "Bob" }, "key-3");
    expect(res2.status).toBe(422);
    const body = (await res2.json()) as { code: string };
    expect(body.code).toBe("idempotency_conflict");
  });

  it("rejects key longer than 255 chars with 400", async () => {
    const app = createApp();
    const longKey = "a".repeat(256);
    const res = await post(app, "/test", { name: "Alice" }, longKey);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_idempotency_key");
  });

  it("validates key length at 255 boundary (exactly 255 is OK)", async () => {
    const app = createApp();
    const key255 = "a".repeat(255);
    const res = await post(app, "/test", { name: "Alice" }, key255);
    expect(res.status).toBe(201);
  });

  it("releases lock on 5xx so retry is possible", async () => {
    const app = createApp();

    const res1 = await post(app, "/test-500", { name: "Alice" }, "key-5xx");
    expect(res1.status).toBe(500);
    expect(callCount).toBe(1);

    // Second request should execute again (lock released)
    const res2 = await post(app, "/test-500", { name: "Alice" }, "key-5xx");
    expect(res2.status).toBe(500);
    expect(callCount).toBe(2);
  });
});
