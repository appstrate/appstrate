import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/index.ts";
import { requestId } from "../request-id.ts";

describe("requestId middleware", () => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId());
  app.get("/test", (c) => c.json({ requestId: c.get("requestId") }));

  test("adds Request-Id response header with req_ prefix", async () => {
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const header = res.headers.get("Request-Id");
    expect(header).toBeTruthy();
    expect(header!.startsWith("req_")).toBe(true);
  });

  test("stores requestId in context", async () => {
    const res = await app.request("/test");
    const json = (await res.json()) as { requestId: string };
    expect(json.requestId).toBeTruthy();
    expect(json.requestId.startsWith("req_")).toBe(true);
  });

  test("generates unique IDs per request", async () => {
    const res1 = await app.request("/test");
    const res2 = await app.request("/test");
    const id1 = res1.headers.get("Request-Id");
    const id2 = res2.headers.get("Request-Id");
    expect(id1).not.toBe(id2);
  });

  test("Request-Id header matches context requestId", async () => {
    const res = await app.request("/test");
    const header = res.headers.get("Request-Id");
    const json = (await res.json()) as { requestId: string };
    expect(header).toBe(json.requestId);
  });
});
