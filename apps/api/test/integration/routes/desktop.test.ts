// SPDX-License-Identifier: Apache-2.0

/**
 * Desktop bridge — the two HTTP surfaces that sit in front of the
 * in-memory client registry.
 *
 *   - `/api/desktop/me/*` — user-scoped, cookie-authenticated. A desktop
 *     belongs to a person, so the only authorization question is "is
 *     this MY desktop": user A must never reach user B's client.
 *   - `/internal/desktop-command` — run-token authenticated, called by
 *     the sidecar's `desktop_browser` tool. Dispatches to the run
 *     OWNER's desktop; a run with no owning user has none.
 *
 * The WebSocket upgrade itself is not exercised here (Hono's
 * `app.request()` cannot upgrade); the registry is driven directly
 * through `registerClient`, which is exactly what the upgrade handler
 * does once auth resolves. Registry mechanics (displacement, reply
 * correlation, timeouts) live in the service's own unit test.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";
import {
  registerClient,
  unregisterClient,
  isConnected,
} from "../../../src/services/desktop-registry.ts";

const app = getTestApp();

const AGENT = "@deskorg/test-agent";

/**
 * Stand-in for the Electron client: records what the platform sends and
 * answers every command with a canned result, mimicking the JSON-RPC
 * reply the real bridge posts back over the socket.
 */
function fakeDesktop(userId: string, reply: unknown = { ok: true }) {
  const sent: Array<{ id: string; method: string; params: unknown }> = [];
  const client = {
    userId,
    send(payload: string): void {
      const frame = JSON.parse(payload) as { id: string; method: string; params: unknown };
      sent.push(frame);
      // Replies are correlated by id — answer on the next tick so the
      // awaiting `sendCommand` promise is already registered.
      void Promise.resolve().then(async () => {
        const { handleClientReply } = await import("../../../src/services/desktop-registry.ts");
        handleClientReply({ id: frame.id, result: reply });
      });
    },
    close(): void {},
  };
  registerClient(client);
  return { client, sent };
}

describe("Desktop bridge — /api/desktop/me/*", () => {
  let ctx: TestContext;
  let connected: ReturnType<typeof fakeDesktop> | null = null;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "deskorg" });
    connected = null;
  });

  afterEach(() => {
    if (connected) unregisterClient(ctx.user.id, connected.client);
  });

  it("requires authentication", async () => {
    const res = await app.request("/api/desktop/me/status");
    expect(res.status).toBe(401);
  });

  it("reports disconnected when no desktop is registered", async () => {
    const res = await app.request("/api/desktop/me/status", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it("reports connected once a client registers, and forwards commands to it", async () => {
    connected = fakeDesktop(ctx.user.id, { url: "https://example.com" });

    const status = await app.request("/api/desktop/me/status", { headers: authHeaders(ctx) });
    expect(await status.json()).toEqual({ connected: true });

    const res = await app.request("/api/desktop/me/command", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "browser.navigate",
        params: { url: "https://example.com" },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { url: "https://example.com" } });
    expect(connected.sent).toHaveLength(1);
    expect(connected.sent[0]!.method).toBe("browser.navigate");
    expect(connected.sent[0]!.params).toEqual({ url: "https://example.com" });
  });

  it("returns 503 when the caller has no desktop connected", async () => {
    const res = await app.request("/api/desktop/me/command", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ method: "browser.navigate", params: { url: "https://example.com" } }),
    });
    expect(res.status).toBe(503);
  });

  it("rejects a body without a `method`", async () => {
    const res = await app.request("/api/desktop/me/command", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ params: { url: "https://example.com" } }),
    });
    expect(res.status).toBe(400);
  });

  it("never reaches another user's desktop", async () => {
    const other = await createTestContext({ orgSlug: "otherorg" });
    connected = fakeDesktop(ctx.user.id);

    // `other` has no desktop of their own — the registry must not fall
    // back to whatever client happens to be connected.
    const status = await app.request("/api/desktop/me/status", { headers: authHeaders(other) });
    expect(await status.json()).toEqual({ connected: false });

    const res = await app.request("/api/desktop/me/command", {
      method: "POST",
      headers: { ...authHeaders(other), "Content-Type": "application/json" },
      body: JSON.stringify({ method: "browser.navigate", params: { url: "https://evil.test" } }),
    });
    expect(res.status).toBe(503);
    expect(connected.sent).toHaveLength(0);
  });
});

describe("Desktop bridge — POST /internal/desktop-command", () => {
  let ctx: TestContext;
  let token: string;
  let connected: ReturnType<typeof fakeDesktop> | null = null;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "deskorg" });
    await seedAgent({ id: AGENT, orgId: ctx.orgId, createdBy: ctx.user.id });
    const run = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "running",
    });
    token = signRunToken(run.id);
    connected = null;
  });

  afterEach(() => {
    if (connected) unregisterClient(ctx.user.id, connected.client);
  });

  it("returns 401 without a run token", async () => {
    const res = await app.request("/internal/desktop-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "browser.navigate" }),
    });
    expect(res.status).toBe(401);
  });

  it("dispatches to the run owner's desktop", async () => {
    connected = fakeDesktop(ctx.user.id, { title: "Example Domain" });

    const res = await app.request("/internal/desktop-command", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "browser.evaluate",
        params: { script: "document.title" },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { title: "Example Domain" } });
    expect(connected.sent[0]!.method).toBe("browser.evaluate");
  });

  it("returns 503 when the owner has no desktop connected", async () => {
    const res = await app.request("/internal/desktop-command", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "browser.screenshot" }),
    });
    expect(res.status).toBe(503);
  });

  it("refuses a run with no owning user — there is no desktop to drive", async () => {
    const ownerless = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: null,
      status: "running",
    });
    connected = fakeDesktop(ctx.user.id);

    const res = await app.request("/internal/desktop-command", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${signRunToken(ownerless.id)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method: "browser.navigate", params: { url: "https://example.com" } }),
    });
    expect(res.status).toBe(403);
    expect(connected.sent).toHaveLength(0);
  });

  it("leaves the registry clean after unregistering", () => {
    connected = fakeDesktop(ctx.user.id);
    expect(isConnected(ctx.user.id)).toBe(true);
    unregisterClient(ctx.user.id, connected.client);
    expect(isConnected(ctx.user.id)).toBe(false);
    connected = null;
  });
});
