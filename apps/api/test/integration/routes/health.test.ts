import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";

const app = getTestApp();

describe("GET /health", () => {
  afterAll(async () => {
    await truncateAll();
  });

  it("returns 200 with healthy or degraded status", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // Without boot(), system packages aren't loaded → "degraded" is expected
    expect(body.status).toBe("degraded"); // Without boot(), no system packages → degraded
    expect(body.checks.database.status).toBe("healthy");
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  it("includes request ID in response headers", async () => {
    const res = await app.request("/health");
    const reqId = res.headers.get("Request-Id");
    expect(reqId).not.toBeNull();
    expect(reqId!).toStartWith("req_");
  });

  it("returns application/json content-type", async () => {
    const res = await app.request("/health");
    const contentType = res.headers.get("content-type");
    expect(contentType).not.toBeNull();
    expect(contentType!).toContain("application/json");
  });

  it("response body contains all required top-level fields", async () => {
    const res = await app.request("/health");
    const body = await res.json() as any;

    // Top-level fields
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("uptime_ms");
    expect(body).toHaveProperty("checks");

    // status is one of the valid values
    expect(["healthy", "degraded", "unhealthy"]).toContain(body.status);

    // uptime_ms is a non-negative number
    expect(typeof body.uptime_ms).toBe("number");
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  it("checks object contains database and flows sub-checks", async () => {
    const res = await app.request("/health");
    const body = await res.json() as any;

    // Database check structure
    expect(body.checks).toHaveProperty("database");
    expect(body.checks.database).toHaveProperty("status");
    expect(["healthy", "unhealthy"]).toContain(body.checks.database.status);
    expect(body.checks.database).toHaveProperty("latency_ms");
    expect(typeof body.checks.database.latency_ms).toBe("number");
    expect(body.checks.database.latency_ms).toBeGreaterThanOrEqual(0);

    // Flows check structure
    expect(body.checks).toHaveProperty("flows");
    expect(body.checks.flows).toHaveProperty("status");
    expect(["healthy", "degraded"]).toContain(body.checks.flows.status);
  });

  it("returns HTTP 200 when database is reachable", async () => {
    const res = await app.request("/health");
    // Even if degraded (no system packages), the HTTP status should be 200
    // because the database is healthy — 503 only when "unhealthy"
    expect(res.status).toBe(200);
  });

  it("uptime_ms increases across sequential requests", async () => {
    const res1 = await app.request("/health");
    const body1 = await res1.json() as any;

    // Small delay to ensure uptime difference is measurable
    await Bun.sleep(10);

    const res2 = await app.request("/health");
    const body2 = await res2.json() as any;

    expect(body2.uptime_ms).toBeGreaterThan(body1.uptime_ms);
  });
});
