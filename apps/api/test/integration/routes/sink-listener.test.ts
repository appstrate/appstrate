// SPDX-License-Identifier: Apache-2.0

/**
 * Guest-facing sink listener (`lib/sink-server.ts`, served on
 * `SINK_LISTENER_PORT`).
 *
 * Contract under test — the listener is the SECURITY boundary that lets
 * the Firecracker firewall's port scoping be sink-only:
 *
 *   1. The routes guest workloads need ARE mounted and behave exactly like
 *      the main app's (same route factories): HMAC-signed run-event
 *      ingestion works end-to-end, and its auth middleware rejects
 *      unsigned requests (401 — proof the signature gate runs, not a bare
 *      handler). Same for the run-token `/internal/*` surface.
 *   2. EVERYTHING else is absent — session/API-key platform routes return
 *      404 problem+json, never a handler.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { createSinkApp } from "../../../src/lib/sink-server.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";

const app = createSinkApp();

const RUN_SECRET = "a".repeat(43); // matches mintSinkCredentials base64url(32 bytes)

function signedHeaders(secret: string, body: string) {
  const msgId = `msg_${crypto.randomUUID()}`;
  const timestampSec = Math.floor(Date.now() / 1000);
  const headers = sign({ msgId, timestampSec, body, secret });
  return {
    "Content-Type": "application/json",
    "webhook-id": headers["webhook-id"],
    "webhook-timestamp": headers["webhook-timestamp"],
    "webhook-signature": headers["webhook-signature"],
  };
}

async function seedRunWithSink(ctx: TestContext, packageId: string): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: "running",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    startedAt: new Date(),
    tokenUsage: { input_tokens: 100, output_tokens: 50 },
  });
  return runId;
}

function progressEnvelope(): Record<string, unknown> {
  return {
    specversion: "1.0",
    type: "appstrate.progress",
    source: "appstrate/runner",
    id: `msg_${crypto.randomUUID()}`,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: { message: "sink listener test", timestamp: Date.now() },
    sequence: 1,
  };
}

describe("sink listener (createSinkApp)", () => {
  let ctx: TestContext;
  let packageId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    packageId = (await seedPackage({ orgId: ctx.orgId })).id;
  });

  it("serves HMAC-signed run-event ingestion end-to-end", async () => {
    const runId = await seedRunWithSink(ctx, packageId);
    const body = JSON.stringify(progressEnvelope());
    const res = await app.request(`/api/runs/${runId}/events`, {
      method: "POST",
      headers: signedHeaders(RUN_SECRET, body),
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it("rejects unsigned event POSTs with 401 (signature middleware is mounted)", async () => {
    const runId = await seedRunWithSink(ctx, packageId);
    const res = await app.request(`/api/runs/${runId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(progressEnvelope()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrongly-signed event POSTs with 401", async () => {
    const runId = await seedRunWithSink(ctx, packageId);
    const body = JSON.stringify(progressEnvelope());
    const res = await app.request(`/api/runs/${runId}/events`, {
      method: "POST",
      headers: signedHeaders("b".repeat(43), body),
      body,
    });
    expect(res.status).toBe(401);
  });

  it("serves the /internal/* run-token surface (401 without a bearer, not 404)", async () => {
    const res = await app.request("/internal/run-history");
    expect(res.status).toBe(401);
  });

  it("returns 404 problem+json for non-sink platform routes", async () => {
    for (const [method, path] of [
      ["GET", "/api/organizations"],
      ["GET", "/api/agents"],
      ["POST", "/api/api-keys"],
      ["GET", "/api/me"],
      ["GET", "/"],
      ["GET", "/api/openapi.json"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
    }
  });

  it("serves /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(["healthy", "degraded"]).toContain(json.status);
  });

  it("gates POSTs behind the shared shutdown flag", async () => {
    let down = false;
    const gated = createSinkApp({ isShuttingDown: () => down });
    const runId = await seedRunWithSink(ctx, packageId);
    const body = JSON.stringify(progressEnvelope());
    down = true;
    const res = await gated.request(`/api/runs/${runId}/events`, {
      method: "POST",
      headers: signedHeaders(RUN_SECRET, body),
      body,
    });
    expect(res.status).toBe(503);
  });
});
