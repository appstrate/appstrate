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
 *   - `ProxyAuthorizationError` (target off the `authorizedUris` allowlist)
 *     → 403
 *   - `ProxyCredentialError` (no connection / integration not installed) → 404
 *   - several own connections and no `X-Connection-Id` → 409 must_choose_connection
 *   - `X-Run-Id` confines the call to the run's bound connections; without it
 *     the space-level rules (org defaults, named, own) pick the connection
 *   - cookie-session rejection by the `ACCEPTED_AUTH_METHODS` gate → 403
 *
 * Auth is a Bearer API key scoped with `credential-proxy:call` — cookie
 * sessions are refused by design and the route only accepts API keys /
 * device-flow JWTs.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { seedApiKey, seedPackage, seedRun, seedSpace } from "../../helpers/seed.ts";
import {
  spacePackages,
  integrationConnections,
  integrationOrgDefaults,
} from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { eq } from "drizzle-orm";
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
    // Homed in the space: a `space_packages` row only speaks for a space the
    // package is PLACED in.
    homeSpaceId: ctx.defaultSpaceId,
    draftManifest: gmailManifest(),
  });
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
        "X-Space-Id": ctx.defaultSpaceId,
        // Integration is never seeded / installed → resolver throws
        // IntegrationCredentialNotFoundError → ProxyCredentialError → 404.
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
    // a ProxyCredentialError). The route's catch must surface its 404 status
    // rather than masking it as a 500.
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(),
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
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        // Off the `https://gmail.googleapis.com/**` allowlist → blocked.
        "X-Target": "https://evil.example.com/exfil",
        "X-Session-Id": uuidV4(),
      },
    });
    expect(res.status).toBe(403);
    // Allowlist gate fires before the upstream fetch.
    expect(upstreamCalls).toBe(0);
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
      resolvedConnections: { [INTEGRATION_ID]: [{ connectionId: own1, source: "member_pin" }] },
    });
    const res = await call({ "X-Run-Id": run.id });
    expect(res.status).toBe(404);
    expect(upstreamAuth).toEqual([]);
  });

  it("without X-Run-Id falls back to the actor's single own connection", async () => {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, own2));
    const res = await call({});
    expect(res.status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-own-1"]);
  });

  it("without X-Run-Id and no own connection, a colleague's shared one is a 409 candidate — never picked", async () => {
    await db.delete(integrationConnections).where(eq(integrationConnections.userId, ctx.user.id));
    const res = await call({});
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      errors: { candidate_connections: { id: string; owned_by_actor: boolean }[] }[];
    };
    expect(body.code).toBe("must_choose_connection");
    expect(body.errors[0]!.candidate_connections).toEqual([
      expect.objectContaining({ id: shared, owned_by_actor: false }),
    ]);
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
