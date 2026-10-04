// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level integration tests for `/api/credential-proxy/proxy`.
 *
 * These pin the handler's request-validation + error→status mapping that
 * the service-level `credential-proxy-injection.test.ts` (which calls
 * `proxyCall()` directly) does NOT exercise:
 *
 *   - missing / malformed control headers → 400
 *     (`X-Integration-Id`, `X-Target`, non-UUIDv4 `X-Session-Id`)
 *   - the session-principal rebind guard → 403
 *     (a session bound to principal A, replayed by principal B)
 *   - `unauthorized_target` (target off the `authorizedUris` allowlist)
 *     → 403
 *   - `credential_not_found` (no connection / integration not installed) → 404
 *   - several own connections and no `X-Connection-Id` → 409 must_choose_connection
 *   - `X-Run-Id` confines the call to the run's bound connections; without it
 *     the space-level rules (org defaults, named, own) pick the connection
 *   - upstream `Set-Cookie` never relayed; the server-side jar keeps continuity
 *   - cookie-session rejection by the `ACCEPTED_AUTH_METHODS` gate → 403
 *
 * Auth is a Bearer API key scoped with `credential-proxy:call` — cookie
 * sessions are refused by design and the route only accepts API keys /
 * device-flow JWTs.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { flushRedis } from "../../helpers/redis.ts";
import {
  seedApiKey,
  seedPackage,
  seedRun,
  seedSpace,
  seedPublishedVersion,
} from "../../helpers/seed.ts";
import {
  auditEvents,
  spacePackages,
  integrationConnections,
  integrationOrgDefaults,
} from "@appstrate/db/schema";
import { drainAudits } from "../../../src/services/audit.ts";
import { auditForeignConnectionUse } from "../../../src/services/credential-proxy/connection-audit.ts";
import type { AppEnv } from "../../../src/types/index.ts";
import { logger } from "../../../src/lib/logger.ts";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import { updateConnectionMetadata } from "../../../src/services/integration-pins-service.ts";
import {
  seedProxyIntegration,
  seedProxyConnection,
} from "../../helpers/credential-proxy-fixtures.ts";

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
    // Homed in the space: a `space_packages` row only speaks for a space the
    // package is PLACED in.
    homeSpaceId: ctx.defaultSpaceId,
    draftManifest: gmailManifest(),
  });
  await seedPublishedVersion(INTEGRATION_ID, "1.0.0");
  // Activate the integration in the default space.
  await db.insert(spacePackages).values({
    spaceId: ctx.defaultSpaceId,
    packageId: INTEGRATION_ID,
  });
  // A live connection owned by the API key's owner (the resolved actor).
  await db.insert(integrationConnections).values({
    integrationId: INTEGRATION_ID,
    authKey: "api",
    accountId: "acct-1",
    label: "acct-1",
    spaceId: ctx.defaultSpaceId,
    userId: ctx.user.id,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "ya29.live-token" } }),
    scopesGranted: [],
    sharedWithOrg: false,
  });
}

/** Mint a `credential-proxy:call`-scoped API key owned by ctx.user. */
async function mintProxyKey(ctx: TestContext): Promise<string> {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
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

  it("returns 400 when X-Integration-Id is missing", async () => {
    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/X-Integration-Id/i);
  });

  it("returns 400 when X-Target is missing", async () => {
    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
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
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
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
      "X-Space-Id": ctx.defaultSpaceId,
      "X-Integration-Id": INTEGRATION_ID,
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

  it("forbids caching a relayed response whatever the upstream allows", async () => {
    const apiKey = await mintProxyKey(ctx);
    mockUpstream(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "private, max-age=60" },
        }),
    );

    const res = await app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
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
      "X-Space-Id": ctx.defaultSpaceId,
      "X-Integration-Id": INTEGRATION_ID,
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

  it("maps a not-installed integration to 404 (credential_not_found)", async () => {
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
        "X-Space-Id": ctx.defaultSpaceId,
        // Integration is never seeded / installed → resolver throws
        // IntegrationCredentialNotFoundError → credential_not_found → 404.
        "X-Integration-Id": "@cporg/missing",
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
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: gmailManifest(),
    });
    await seedPublishedVersion(INTEGRATION_ID, "1.0.0");
    await db.insert(spacePackages).values({
      spaceId: ctx.defaultSpaceId,
      packageId: INTEGRATION_ID,
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
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });

  it("maps an integration not activated in the space to 404 (not 500)", async () => {
    // Package exists in the org but is NOT inserted into spacePackages,
    // so assertIntegrationActive throws an RFC 9457 notFound (an ApiError, not
    // a credential_not_found). The route's catch must surface its 404 status
    // rather than masking it as a 500.
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(),
    });
    await seedPublishedVersion(INTEGRATION_ID, "1.0.0");

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
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });

  it("maps an off-allowlist target to 403 (unauthorized_target)", async () => {
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
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        // Off the `https://gmail.googleapis.com/**` allowlist → blocked.
        "X-Target": "https://evil.example.com/exfil",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized_target");
    expect(res.headers.get("Proxy-Status")).toBe("appstrate; error=http_request_denied");
    // Allowlist gate fires before the upstream fetch.
    expect(upstreamCalls).toBe(0);
  });

  it("relays an upstream 401 as the upstream's: Proxy-Status, no platform challenge", async () => {
    await seedIntegrationWithConnection(ctx);
    mockUpstream(async () => new Response('{"error":"expired"}', { status: 401 }));

    const res = await app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Proxy-Status")).toBe("appstrate; received-status=401");
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    expect(await res.text()).toBe('{"error":"expired"}');
  });

  it("maps several own connections and no X-Connection-Id to 409 must_choose_connection", async () => {
    await seedIntegrationWithConnection(ctx);
    await db.insert(integrationConnections).values({
      integrationId: INTEGRATION_ID,
      authKey: "api",
      accountId: "acct-2",
      label: "acct-2",
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "second-token" } }),
      scopesGranted: [],
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
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type") ?? "").toContain("application/problem+json");
    const body = (await res.json()) as {
      code: string;
      errors: { code: string; candidate_connections: { label: string }[] }[];
    };
    expect(body.code).toBe("must_choose_connection");
    expect(body.errors[0]!.code).toBe("must_choose_connection");
    expect(body.errors[0]!.candidate_connections.map((c) => c.label).sort()).toEqual([
      "acct-1",
      "acct-2",
    ]);
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
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
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

describe("POST /api/credential-proxy/proxy — response capping (X-Truncated header)", () => {
  let ctx: TestContext;
  let apiKey: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "cporg" });
    await seedIntegrationWithConnection(ctx);
    apiKey = await mintProxyKey(ctx);
  });
  afterEach(() => restoreFetch());

  // The route caps non-streaming responses at `limits.max_response_bytes`
  // (default 50 MiB) and sets `X-Truncated: true` once the capped body is
  // drained. The service test (`credential-proxy-truncation.test.ts`)
  // exercises `proxyCall`'s live `truncated` getter; this asserts the ROUTE
  // actually emits the header on a capped non-streaming response.
  const CAP = 50 * 1024 * 1024;

  /** A streaming body that lazily emits `total` bytes in 1 MiB chunks. */
  function oversizedBody(total: number): ReadableStream<Uint8Array> {
    const chunk = new Uint8Array(1024 * 1024); // 1 MiB
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const remaining = total - sent;
        controller.enqueue(remaining >= chunk.byteLength ? chunk : chunk.subarray(0, remaining));
        sent += chunk.byteLength;
      },
    });
  }

  it("sets X-Truncated: true on a capped non-streaming response", async () => {
    // Upstream returns more than the cap → the route's capping transform
    // stops at the cap and the route emits X-Truncated. No x-stream-response
    // header → the buffered (non-streaming) path.
    mockUpstream(
      async () =>
        new Response(oversizedBody(CAP + 1024), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );

    const res = await app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBe("true");
    // Drain the (capped) body so the response stream is fully consumed.
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(CAP);
  });

  it("does not set X-Truncated when the body fits under the cap", async () => {
    mockUpstream(
      async () =>
        new Response('{"messages":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated")).toBeNull();
  });
});

describe("POST /api/credential-proxy/proxy — boolean control headers take 1/0", () => {
  let ctx: TestContext;
  let apiKey: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "cporg" });
    await seedIntegrationWithConnection(ctx);
    apiKey = await mintProxyKey(ctx);
  });
  afterEach(() => restoreFetch());

  function proxyPost(extra: Record<string, string>, body?: string) {
    return app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
        "Content-Type": "application/json",
        ...extra,
      },
      body,
    });
  }

  it("X-Substitute-Body: 1 substitutes placeholders in the body", async () => {
    let upstreamBody = "";
    mockUpstream(async (_input, init) => {
      upstreamBody = await new Response(init?.body).text();
      return new Response("{}", { status: 200 });
    });
    const res = await proxyPost({ "X-Substitute-Body": "1" }, '{"token":"{{api_key}}"}');
    expect(res.status).toBe(200);
    expect(upstreamBody).toBe('{"token":"ya29.live-token"}');
  });

  it("forwards a streamed upload's Content-Length, never hop-by-hop or Connection-named headers", async () => {
    let sent: Headers | null = null;
    mockUpstream(async (_input, init) => {
      sent = new Headers(init?.headers);
      await new Response(init?.body).arrayBuffer();
      return new Response("{}", { status: 200 });
    });
    const res = await proxyPost(
      {
        "X-Stream-Request": "1",
        "Content-Length": "2",
        Connection: "x-foo",
        "X-Foo": "1",
        "Keep-Alive": "timeout=5",
      },
      "{}",
    );
    expect(res.status).toBe(200);
    expect(sent!.get("content-length")).toBe("2");
    for (const name of ["connection", "x-foo", "keep-alive"]) expect(sent!.get(name)).toBeNull();
  });

  it("never forwards its own control headers upstream, X-Org-Id included", async () => {
    let sent: Headers | null = null;
    mockUpstream(async (_input, init) => {
      sent = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    });
    const res = await proxyPost({ "X-Custom": "kept" }, "{}");
    expect(res.status).toBe(200);
    for (const name of ["x-org-id", "x-space-id", "x-integration-id", "x-target", "x-session-id"]) {
      expect(sent!.get(name)).toBeNull();
    }
    expect(sent!.get("x-custom")).toBe("kept");
  });

  for (const [name, value] of [
    ["X-Substitute-Body", "true"],
    ["X-Stream-Request", "yes"],
    ["X-Stream-Response", "false"],
  ] as const) {
    it(`returns 400 on ${name}: ${value}`, async () => {
      mockUpstream(async () => new Response("should not be called", { status: 599 }));
      const res = await proxyPost({ [name]: value }, "{}");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(body.detail ?? "").toContain(`${name} must be "1" or "0"`);
    });
  }
});

describe("POST /api/credential-proxy/proxy — X-Run-Id binds the run's set, else the space-level rules apply", () => {
  const AGENT_ID = "@cporg/agent";
  let ctx: TestContext;
  let apiKey: string;
  let colleagueId: string;
  let own1: string;
  let own2: string;
  let shared: string;
  let upstreamAuth: string[];

  async function insertConnection(accountId: string, userId: string, sharedWithOrg = false) {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "api",
        accountId,
        label: accountId,
        spaceId: ctx.defaultSpaceId,
        userId,
        credentialsEncrypted: encryptCredentialEnvelope({
          outputs: { api_key: `tok-${accountId}` },
        }),
        scopesGranted: [],
        sharedWithOrg,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  async function runBinding(
    connectionIds: string[],
    overrides: { userId?: string; status?: "pending" | "running" | "success" } = {},
  ): Promise<string> {
    const run = await seedRun({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT_ID,
      userId: overrides.userId ?? ctx.user.id,
      status: overrides.status ?? "running",
      runOrigin: "remote",
      resolvedConnections: {
        [INTEGRATION_ID]: connectionIds.map((connectionId) => ({
          connectionId,
          source: "member_pin",
          label: connectionId,
          accountId: connectionId,
        })),
      },
    });
    return run.id;
  }

  function call(extra: Record<string, string>) {
    return app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
        ...extra,
      },
    });
  }

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "cporg" });
    apiKey = await mintProxyKey(ctx);
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: gmailManifest(),
    });
    await seedPublishedVersion(INTEGRATION_ID, "1.0.0");
    await db
      .insert(spacePackages)
      .values({ spaceId: ctx.defaultSpaceId, packageId: INTEGRATION_ID });
    await seedPackage({ id: AGENT_ID, orgId: ctx.orgId, type: "agent", source: "local" });
    colleagueId = (await createTestUser()).id;
    own1 = await insertConnection("own-1", ctx.user.id);
    own2 = await insertConnection("own-2", ctx.user.id);
    shared = await insertConnection("shared", colleagueId, true);
    upstreamAuth = [];
    mockUpstream(async (_input, init) => {
      upstreamAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
  });
  afterEach(() => restoreFetch());

  it("audits a colleague's shared connection once per session, never the caller's own", async () => {
    const runId = await runBinding([shared]);
    const session = uuidV4();
    expect((await call({ "X-Run-Id": runId, "X-Session-Id": session })).status).toBe(200);
    expect((await call({ "X-Run-Id": runId, "X-Session-Id": session })).status).toBe(200);
    expect((await call({ "X-Connection-Id": own1 })).status).toBe(200);
    await drainAudits(5_000);

    const rows = await db
      .select({ resourceId: auditEvents.resourceId, after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, "integration.connection.proxied"));
    expect(rows).toEqual([
      {
        resourceId: shared,
        after: {
          packageId: INTEGRATION_ID,
          sessionId: session,
          runId,
          principalType: "user",
          principalId: ctx.user.id,
          ownerType: "user",
          ownerId: colleagueId,
        },
      },
    ]);
  });

  it("audits a colleague's connection whose upstream fails, not a call refused before sending", async () => {
    mockUpstream(async () => {
      throw new TypeError("fetch failed");
    });
    const runId = await runBinding([shared]);
    expect((await call({ "X-Run-Id": runId })).status).toBe(502);
    const offList = await call({ "X-Run-Id": runId, "X-Target": "https://evil.example.com/x" });
    expect(offList.status).toBe(403);
    await drainAudits(5_000);

    const rows = await db
      .select({ resourceId: auditEvents.resourceId })
      .from(auditEvents)
      .where(eq(auditEvents.action, "integration.connection.proxied"));
    expect(rows).toEqual([{ resourceId: shared }]);
  });

  describe("auditForeignConnectionUse", () => {
    /** One audit call through a bare Hono context, as the route hands it an API-key request. */
    async function audit(actorId: string, session: string): Promise<void> {
      const probe = new Hono<AppEnv>();
      probe.get("/", async (c) => {
        c.set("orgId", ctx.orgId);
        c.set("apiKeyId", "key-1");
        await auditForeignConnectionUse(c, {
          actor: { type: "end_user", id: actorId },
          connectionId: shared,
          integrationId: INTEGRATION_ID,
          sessionId: session,
          runId: null,
          sessionTtlSeconds: 60,
        });
        return c.body(null, 204);
      });
      expect((await probe.request("/")).status).toBe(204);
    }

    async function proxiedRows() {
      return db
        .select({ resourceId: auditEvents.resourceId, after: auditEvents.after })
        .from(auditEvents)
        .where(eq(auditEvents.action, "integration.connection.proxied"));
    }

    it("writes one row per acting principal in a shared session", async () => {
      const session = uuidV4();
      await audit("eu_a", session);
      await audit("eu_b", session);
      await audit("eu_a", session);
      const principals = (await proxiedRows()).map(
        (r) => (r.after as { principalId?: string } | null)?.principalId,
      );
      expect(principals.sort()).toEqual(["eu_a", "eu_b"]);
    });
  });

  it("uses the run's single bound connection — even a colleague's shared one — without naming it", async () => {
    const runId = await runBinding([shared]);
    const res = await call({ "X-Run-Id": runId });
    expect(res.status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-shared"]);
  });

  it("answers 409 over the bound set when it holds several and none is named", async () => {
    const runId = await runBinding([own1, own2]);
    const res = await call({ "X-Run-Id": runId });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      errors: { candidate_connections: { id: string }[] }[];
    };
    expect(body.code).toBe("must_choose_connection");
    // The bound set only — the colleague's shared row is accessible but not bound.
    expect(body.errors[0]!.candidate_connections.map((c) => c.id).sort()).toEqual(
      [own1, own2].sort(),
    );
    expect(upstreamAuth).toEqual([]);
  });

  it("uses the named member of a bound set", async () => {
    const runId = await runBinding([own1, own2]);
    const res = await call({ "X-Run-Id": runId, "X-Connection-Id": own2 });
    expect(res.status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-own-2"]);
  });

  it("refuses a bound connection flagged needs_reconnection (409), as without a run", async () => {
    await db
      .update(integrationConnections)
      .set({ needsReconnection: true })
      .where(eq(integrationConnections.id, own1));
    const runId = await runBinding([own1]);
    const res = await call({ "X-Run-Id": runId });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; errors: { connection_id: string }[] };
    expect(body.code).toBe("needs_reconnection");
    expect(body.errors[0]!.connection_id).toBe(own1);
    expect((await call({ "X-Connection-Id": own1 })).status).toBe(409);
    expect(upstreamAuth).toEqual([]);
  });

  it("keys the session's cookie jar per connection, never per integration", async () => {
    const sent: { auth: string; cookie: string | null }[] = [];
    mockUpstream(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization") ?? "";
      sent.push({ auth, cookie: headers.get("cookie") });
      return new Response("{}", {
        status: 200,
        headers: { "Set-Cookie": `sid=${auth.slice(-5)}; Path=/` },
      });
    });
    const session = { "X-Session-Id": uuidV4() };
    await call({ ...session, "X-Connection-Id": own1 });
    await call({ ...session, "X-Connection-Id": own2 });
    await call({ ...session, "X-Connection-Id": own1 });
    expect(sent.map((s) => s.cookie?.split(";")[0] ?? null)).toEqual([null, null, "sid=own-1"]);
  });

  it("stops serving a bound shared connection its owner unshares mid-run (404)", async () => {
    const runId = await runBinding([shared]);
    expect((await call({ "X-Run-Id": runId })).status).toBe(200);

    await updateConnectionMetadata(shared, { sharedWithOrg: false });

    expect((await call({ "X-Run-Id": runId })).status).toBe(404);
    expect(upstreamAuth).toEqual(["Bearer tok-shared"]);
  });

  it("refuses a colleague's private connection named without X-Run-Id as not connected (404)", async () => {
    const theirs = await insertConnection("colleague-private", colleagueId);
    const res = await call({ "X-Connection-Id": theirs });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("colleague-private");
    // Control: the caller's own connection named the same way is served.
    expect((await call({ "X-Connection-Id": own1 })).status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-own-1"]);
  });

  it("refuses a named connection the run did not bind (400 connection_not_in_run)", async () => {
    const runId = await runBinding([own1, own2]);
    const res = await call({ "X-Run-Id": runId, "X-Connection-Id": shared });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("connection_not_in_run");
    expect(upstreamAuth).toEqual([]);
  });

  it("is not connected when the run bound nothing to the integration", async () => {
    const run = await seedRun({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT_ID,
      userId: ctx.user.id,
      status: "running",
      resolvedConnections: {},
    });
    const res = await call({ "X-Run-Id": run.id });
    expect(res.status).toBe(404);
    expect(upstreamAuth).toEqual([]);
  });

  it("refuses another actor's run (403), a finished run (400) and an unknown run (404)", async () => {
    const foreign = await runBinding([shared], { userId: colleagueId });
    expect((await call({ "X-Run-Id": foreign })).status).toBe(403);
    const finished = await runBinding([own1], { status: "success" });
    expect((await call({ "X-Run-Id": finished })).status).toBe(400);
    expect((await call({ "X-Run-Id": "run_doesnotexist0000" })).status).toBe(404);
    expect(upstreamAuth).toEqual([]);
  });

  it("refuses a run of another space as unknown (404)", async () => {
    const otherSpace = await seedSpace({ orgId: ctx.orgId, name: "Other" });
    const run = await seedRun({
      orgId: ctx.orgId,
      spaceId: otherSpace.id,
      packageId: AGENT_ID,
      userId: ctx.user.id,
      status: "running",
      resolvedConnections: {
        [INTEGRATION_ID]: [
          { connectionId: own1, source: "member_pin", label: "own1", accountId: "own1" },
        ],
      },
    });
    const res = await call({ "X-Run-Id": run.id });
    expect(res.status).toBe(404);
    expect(upstreamAuth).toEqual([]);
  });

  async function orgDefault(connectionIds: string[], enforce: boolean) {
    await db.insert(integrationOrgDefaults).values({
      spaceId: ctx.defaultSpaceId,
      integrationId: INTEGRATION_ID,
      connectionIds,
      enforce,
    });
  }

  it("an ENFORCED org default binds a call without X-Run-Id — the caller's own connection is neither picked nor nameable", async () => {
    await orgDefault([shared], true);
    const res = await call({});
    expect(res.status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-shared"]);

    const named = await call({ "X-Connection-Id": own1 });
    expect(named.status).toBe(400);
    expect(((await named.json()) as { code: string }).code).toBe("connection_not_in_org_default");
    expect(upstreamAuth).toEqual(["Bearer tok-shared"]);
  });

  it("an ENFORCED org default of several answers 409 over its set", async () => {
    const shared2 = await insertConnection("shared-2", colleagueId, true);
    await orgDefault([shared, shared2], true);
    const res = await call({});
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      errors: { candidate_connections: { id: string }[] }[];
    };
    expect(body.code).toBe("must_choose_connection");
    expect(body.errors[0]!.candidate_connections.map((c) => c.id).sort()).toEqual(
      [shared, shared2].sort(),
    );
    expect((await call({ "X-Connection-Id": shared2 })).status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-shared-2"]);
  });

  it("a SOFT org default is used when nothing is named; a named connection wins over it", async () => {
    await orgDefault([shared], false);
    expect((await call({})).status).toBe(200);
    expect((await call({ "X-Connection-Id": own2 })).status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-shared", "Bearer tok-own-2"]);
  });

  it("an org default naming a connection the caller cannot reach fails loud (409 pinned_connection_unavailable)", async () => {
    await orgDefault([shared, crypto.randomUUID()], false);
    const res = await call({});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; errors: { code: string }[] };
    expect(body.code).toBe("pinned_connection_unavailable");
    expect(body.errors[0]!.code).toBe("pinned_connection_unavailable");
    expect(upstreamAuth).toEqual([]);
  });
});

describe("POST /api/credential-proxy/proxy — upstream Set-Cookie is never relayed", () => {
  const COOKIE_INTEGRATION = "@cporg/shop";
  let ctx: TestContext;
  let apiKey: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "cporg" });
    // The credential IS a session cookie: a relayed rotation would hand it out.
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({
        name: COOKIE_INTEGRATION,
        displayName: "Shop",
        description: "Shop integration",
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://1.1.1.1/**"],
            delivery: httpHeaderDelivery({ name: "Cookie", prefix: "SID=", field: "api_key" }),
          },
        },
      }),
    );
    await seedProxyConnection(ctx, COOKIE_INTEGRATION, "api", { api_key: "sid-initial" });
    apiKey = await mintProxyKey(ctx);
  });
  afterEach(() => restoreFetch());

  it("drops every Set-Cookie and keeps session continuity in the server-side jar", async () => {
    const upstreamCookies: Array<string | null> = [];
    mockUpstream(async (_input, init) => {
      upstreamCookies.push(new Headers(init?.headers).get("cookie"));
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("Set-Cookie", "SID=sid-rotated; Path=/; HttpOnly");
      headers.append("Set-Cookie", "pref=1; Path=/");
      return new Response("{}", { status: 200, headers });
    });
    const sessionId = uuidV4();
    const proxyGet = () =>
      app.request("/api/credential-proxy/proxy", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Org-Id": ctx.orgId,
          "X-Space-Id": ctx.defaultSpaceId,
          "X-Integration-Id": COOKIE_INTEGRATION,
          "X-Target": "https://1.1.1.1/cart",
          "X-Session-Id": sessionId,
        },
      });

    const first = await proxyGet();
    expect(first.status).toBe(200);
    expect(first.headers.getSetCookie()).toEqual([]);

    const second = await proxyGet();
    expect(second.status).toBe(200);
    expect(second.headers.getSetCookie()).toEqual([]);
    expect(
      upstreamCookies[1]
        ?.split(";")
        .map((p) => p.trim())
        .sort(),
    ).toEqual(["SID=sid-rotated", "pref=1"]);
  });
});

describe("POST /api/credential-proxy/proxy — a credential no header can carry", () => {
  const KEY_INTEGRATION = "@cporg/keyed";
  const SECRET = "SECRETKEY";
  let ctx: TestContext;
  let apiKey: string;
  let upstreamCalls: number;
  let logged: unknown[][];
  const spies: Array<{ mockRestore(): void }> = [];

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "cporg" });
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({
        name: KEY_INTEGRATION,
        displayName: "Keyed",
        description: "Keyed integration",
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://1.1.1.1/**"],
            delivery: httpHeaderDelivery({ name: "X-Api-Key", prefix: "", field: "api_key" }),
          },
        },
      }),
    );
    apiKey = await mintProxyKey(ctx);
    upstreamCalls = 0;
    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 200 });
    });
    logged = [];
    for (const level of ["error", "warn", "info"] as const) {
      spies.push(
        spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
          logged.push(args);
        }) as never),
      );
    }
  });
  afterEach(() => {
    restoreFetch();
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  const call = (headers: Record<string, string> = {}) =>
    app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": KEY_INTEGRATION,
        "X-Target": "https://1.1.1.1/v1",
        "X-Session-Id": uuidV4(),
        ...headers,
      },
    });

  /** The problem the proxy answered, asserted to quote no value anywhere it can reach. */
  async function expectUnusable(res: Response, header: string): Promise<void> {
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(res.headers.get("proxy-status")).toBe("appstrate; error=proxy_configuration_error");
    const body = JSON.parse(text) as { code: string; detail: string };
    expect(body.code).toBe("credential_unusable");
    expect(body.detail.toLowerCase()).toContain(`"${header.toLowerCase()}"`);
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(upstreamCalls).toBe(0);
  }

  // Bun's `Headers` TypeError quotes the value; it reached the 500 log line in full.
  for (const value of [`${SECRET}\r\nX-Evil: 1`, `${SECRET}\u20ac`]) {
    it(`refuses the injected credential ${JSON.stringify(value.slice(SECRET.length))}`, async () => {
      await seedProxyConnection(ctx, KEY_INTEGRATION, "api", { api_key: value });
      await expectUnusable(await call(), "X-Api-Key");
    });

    it(`refuses a caller template rendering ${JSON.stringify(value.slice(SECRET.length))}`, async () => {
      await seedProxyConnection(ctx, KEY_INTEGRATION, "api", { api_key: "ok", password: value });
      await expectUnusable(await call({ "X-Pass": "{{password}}" }), "X-Pass");
    });
  }

  // The lookup runs on the template: a `{{word}}` inside a value is no placeholder.
  it("sends a credential whose value holds a `{{word}}`", async () => {
    await seedProxyConnection(ctx, KEY_INTEGRATION, "api", {
      api_key: "ok",
      password: "pa{{ss}}word",
    });
    const res = await call({ "X-Pass": "{{password}}" });
    expect(res.status).toBe(200);
    expect(upstreamCalls).toBe(1);
  });

  it("answers a caller header value that is no HTTP field value as a 400, the credential intact", async () => {
    await seedProxyConnection(ctx, KEY_INTEGRATION, "api", { api_key: "ok" });
    const res = await call({ "X-Custom": "a\u0001b" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe("invalid_request");
    expect(body.detail.toLowerCase()).toContain('"x-custom"');
    expect(upstreamCalls).toBe(0);
  });

  it("answers a body broken off after the headers as upstream_unreachable, not a 500", async () => {
    await seedProxyConnection(ctx, KEY_INTEGRATION, "api", { api_key: "ok" });
    mockUpstream(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hel"));
          controller.error(new Error("socket closed"));
        },
      });
      return new Response(body, { status: 200 });
    });
    const res = await call();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe("upstream_unreachable");
    expect(body.detail).toBe("1.1.1.1 could not be reached");
  });
});
