// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level integration tests for `/api/credential-proxy/proxy`.
 *
 * These pin the handler's request-validation + error→status mapping that
 * the service-level `credential-proxy-injection.test.ts` (which calls
 * `proxyCall()` directly) does NOT exercise:
 *
 *   - missing / malformed control headers → 400
 *     (`X-Integration`, `X-Target`, non-UUIDv4 `X-Session-Id`)
 *   - the session-principal rebind guard → 403
 *     (a session bound to principal A, replayed by principal B)
 *   - `ProxyAuthorizationError` (target off the `authorizedUris` allowlist)
 *     → 403
 *   - `ProxyCredentialError` (no connection / integration not installed) → 404
 *   - cookie-session rejection by the `ACCEPTED_AUTH_METHODS` gate → 403
 *
 * Auth is a Bearer API key scoped with `credential-proxy:call` — cookie
 * sessions are refused by design and the route only accepts API keys /
 * device-flow JWTs.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { seedApiKey, seedPackage } from "../../helpers/seed.ts";
import { applicationPackages, integrationConnections } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

// ─── Upstream fetch stub ──────────────────────────────────
// The route calls `proxyCall()` which uses `globalThis.fetch` (no DI seam
// at the route boundary). Swap it per-test so a successful proxy call never
// leaves the harness. Error-path tests assert the upstream is never hit.
type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
// Capture the REAL global fetch exactly once at module load. Capturing it
// afresh inside `mockUpstream` was a latent bug: a second `mockUpstream` (or an
// interleaving with another test file that also swaps `globalThis.fetch`) would
// snapshot a stub as the "original", so `restoreFetch` reinstalled a stub and the
// override leaked into unrelated tests (e.g. integration-token-refresh's mock
// OAuth server seeing a 599 stub). Pin it once so restore always returns the
// genuine fetch.
const realFetch: typeof fetch = globalThis.fetch;
function mockUpstream(impl: FetchImpl): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}
function restoreFetch(): void {
  if (realFetch) globalThis.fetch = realFetch;
}

const INTEGRATION_ID = "@cporg/gmail";

function gmailManifest(name = INTEGRATION_ID): IntegrationManifest {
  return localIntegrationManifest({
    name,
    displayName: "Gmail",
    description: "Gmail integration",
    auths: {
      api: {
        type: "api_key",
        authorizedUris: ["https://gmail.googleapis.com/**"],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "api_key",
        }),
      },
    },
  });
}

async function seedIntegrationWithConnection(ctx: TestContext): Promise<void> {
  await seedPackage({
    id: INTEGRATION_ID,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: gmailManifest(),
  });
  // Activate the integration in the default application.
  await db.insert(applicationPackages).values({
    applicationId: ctx.defaultAppId,
    packageId: INTEGRATION_ID,
    config: {},
  });
  // A live connection owned by the API key's owner (the resolved actor).
  await db.insert(integrationConnections).values({
    integrationId: INTEGRATION_ID,
    authKey: "api",
    accountId: "acct-1",
    applicationId: ctx.defaultAppId,
    userId: ctx.user.id,
    credentialsEncrypted: encryptCredentials({ api_key: "ya29.live-token" }),
    scopesGranted: [],
    sharedWithOrg: false,
  });
}

/** Mint a `credential-proxy:call`-scoped API key owned by ctx.user. */
async function mintProxyKey(ctx: TestContext): Promise<string> {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    createdBy: ctx.user.id,
    scopes: ["credential-proxy:call"],
  });
  return key.rawKey;
}

// A syntactically valid UUID v4 session id.
function uuidV4(): string {
  return crypto.randomUUID();
}

describe("POST /api/credential-proxy/proxy — header validation", () => {
  let ctx: TestContext;
  let apiKey: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "cporg" });
    apiKey = await mintProxyKey(ctx);
    // Default: upstream should never be reached on a validation failure.
    mockUpstream(async () => new Response("should not be called", { status: 599 }));
  });
  afterEach(() => restoreFetch());

  it("returns 400 when X-Integration is missing", async () => {
    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Application-Id": ctx.defaultAppId,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/X-Integration/i);
  });

  it("returns 400 when X-Target is missing", async () => {
    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Application-Id": ctx.defaultAppId,
        "X-Integration": INTEGRATION_ID,
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/X-Target/i);
  });

  it("returns 400 when X-Session-Id is not a UUID v4", async () => {
    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Application-Id": ctx.defaultAppId,
        "X-Integration": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": "not-a-uuid",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/UUID v4/i);
  });
});

describe("POST /api/credential-proxy/proxy — session-principal rebind guard", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "cporg" });
    await seedIntegrationWithConnection(ctx);
  });
  afterEach(() => restoreFetch());

  it("403s when a session bound to principal A is replayed by principal B", async () => {
    // Two distinct API keys → two distinct namespaced principals
    // (`apikey:<id>`), even though both belong to the same org/user.
    const keyA = await mintProxyKey(ctx);
    const keyB = await mintProxyKey(ctx);
    const sessionId = uuidV4();

    let upstreamCalls = 0;
    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response('{"messages":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const baseHeaders = (apiKey: string) => ({
      Authorization: `Bearer ${apiKey}`,
      "X-Org-Id": ctx.orgId,
      "X-Application-Id": ctx.defaultAppId,
      "X-Integration": INTEGRATION_ID,
      "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      "X-Session-Id": sessionId,
    });

    // Principal A binds the session — succeeds end-to-end (stubbed upstream).
    const first = await app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: baseHeaders(keyA),
    });
    expect(first.status).toBe(200);
    expect(upstreamCalls).toBe(1);

    // Principal B replays the same session id — rebind guard fires BEFORE
    // any credential resolution or upstream contact.
    const second = await app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: baseHeaders(keyB),
    });
    expect(second.status).toBe(403);
    const body = (await second.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/bound to a different principal/i);
    // No second upstream call — B never got past the guard.
    expect(upstreamCalls).toBe(1);
  });

  it("allows the same principal to reuse its own session id", async () => {
    const apiKey = await mintProxyKey(ctx);
    const sessionId = uuidV4();

    let upstreamCalls = 0;
    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response('{"messages":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "X-Org-Id": ctx.orgId,
      "X-Application-Id": ctx.defaultAppId,
      "X-Integration": INTEGRATION_ID,
      "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      "X-Session-Id": sessionId,
    };

    const first = await app.request("/api/credential-proxy/proxy", { method: "GET", headers });
    expect(first.status).toBe(200);
    const second = await app.request("/api/credential-proxy/proxy", { method: "GET", headers });
    expect(second.status).toBe(200);
    expect(upstreamCalls).toBe(2);
  });
});

describe("POST /api/credential-proxy/proxy — error→status mapping", () => {
  let ctx: TestContext;
  let apiKey: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "cporg" });
    apiKey = await mintProxyKey(ctx);
  });
  afterEach(() => restoreFetch());

  it("maps a not-installed integration to 404 (ProxyCredentialError)", async () => {
    let upstreamCalls = 0;
    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response("nope", { status: 599 });
    });

    const res = await app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Application-Id": ctx.defaultAppId,
        // Integration is never seeded / installed → resolver throws
        // IntegrationCredentialNotFoundError → ProxyCredentialError → 404.
        "X-Integration": "@cporg/missing",
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });

  it("maps an installed integration with no connection to 404", async () => {
    // Seed + activate the integration but DO NOT create a connection.
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(),
    });
    await db.insert(applicationPackages).values({
      applicationId: ctx.defaultAppId,
      packageId: INTEGRATION_ID,
      config: {},
    });

    let upstreamCalls = 0;
    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response("nope", { status: 599 });
    });

    const res = await app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Application-Id": ctx.defaultAppId,
        "X-Integration": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });

  it("maps an off-allowlist target to 403 (ProxyAuthorizationError)", async () => {
    await seedIntegrationWithConnection(ctx);

    let upstreamCalls = 0;
    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response("nope", { status: 599 });
    });

    const res = await app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Application-Id": ctx.defaultAppId,
        "X-Integration": INTEGRATION_ID,
        // Off the `https://gmail.googleapis.com/**` allowlist → blocked.
        "X-Target": "https://evil.example.com/exfil",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(403);
    // Allowlist gate fires before the upstream fetch.
    expect(upstreamCalls).toBe(0);
  });
});

describe("POST /api/credential-proxy/proxy — cookie-session rejection (ACCEPTED_AUTH_METHODS gate)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "cporg" });
    await seedIntegrationWithConnection(ctx);
    // Upstream must never be contacted — the auth-method gate fires inside
    // the handler before any credential resolution / fetch.
    mockUpstream(async () => new Response("should not be called", { status: 599 }));
  });
  afterEach(() => restoreFetch());

  it("403s a cookie session even though the owner holds credential-proxy:call", async () => {
    // The owner role grants `credential-proxy:call`, so `requirePermission`
    // passes and execution reaches the `ACCEPTED_AUTH_METHODS` gate. That gate
    // rejects `authMethod === "session"` — cookie sessions are refused because
    // the drive-by CSRF threat model doesn't fit an endpoint that reaches
    // third-party providers. Only Bearer API keys / device-flow JWTs are
    // accepted.
    let upstreamCalls = 0;
    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response("should not be called", { status: 599 });
    });

    const res = await app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        // Cookie session (NOT a Bearer api_key) → authMethod = "session".
        Cookie: ctx.cookie,
        "X-Org-Id": ctx.orgId,
        "X-Application-Id": ctx.defaultAppId,
        "X-Integration": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail?: string };
    // Matches the route's verbatim message
    // (`credential-proxy.ts` ACCEPTED_AUTH_METHODS branch).
    expect(body.detail ?? "").toMatch(/cookie sessions and unknown strategies rejected/i);
    expect(body.detail ?? "").toMatch(/auth method "session"/i);
    // The gate fires before any credential resolution / upstream contact.
    expect(upstreamCalls).toBe(0);
  });
});
