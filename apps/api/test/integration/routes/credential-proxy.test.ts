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
 *   - one permission per path: `credential-proxy:call` with `X-Run-Id` (the caller's own
 *     in-flight run, executed by the caller), `credential-proxy:direct` without
 *   - `X-Run-Id` confines the call to the run's bound connections; without it
 *     only the caller's own connections are reachable
 *   - `GET /api/credential-proxy/connections` lists what a call without a run reaches
 *   - upstream `Set-Cookie` never relayed; the server-side jar keeps continuity
 *   - the call journal: a row per call that may have sent the credential (the
 *     upstream answered, or the call failed after dispatch), none for a refusal
 *   - cookie-session rejection by the `ACCEPTED_AUTH_METHODS` gate → 403
 *
 * Auth is a Bearer API key — cookie sessions are refused by design and the
 * route only accepts API keys / device-flow JWTs (the JWT door is covered in
 * `modules/oidc/test/integration/routes/credential-proxy-jwt.test.ts`). Of
 * the space presets only `admin` grants `credential-proxy:direct`; the caller
 * here is an org member holding it through a custom space role.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  memberContext,
  memberHolding,
  type TestContext,
} from "../../helpers/auth.ts";
import { flushRedis } from "../../helpers/redis.ts";
import {
  seedApiKey,
  seedEndUser,
  seedPackage,
  seedRun,
  seedSpace,
  seedSpacePackage,
  seedPublishedVersion,
} from "../../helpers/seed.ts";
import {
  connectionCalls,
  spacePackages,
  integrationConnections,
  integrationOrgDefaults,
  integrationConnectionShares,
} from "@appstrate/db/schema";
import { drainAudits } from "../../../src/services/audit.ts";
import { CURRENT_API_VERSION } from "../../../src/lib/api-versions.ts";
import { logger } from "../../../src/lib/logger.ts";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import {
  seedProxyIntegration,
  seedProxyConnection,
} from "../../helpers/credential-proxy-fixtures.ts";
import { seedShares } from "../../helpers/connection-shares.ts";
import { expectProblem } from "../../helpers/assertions.ts";

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

/** The Gmail integration, published and switched on in the context's default space. */
async function seedGmailIntegration(ctx: TestContext): Promise<void> {
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
}

/**
 * A connection of `owner.user` labelled `accountId`, whose credential is `tok-<accountId>`;
 * scoped to the default space and of the Gmail integration unless `opts` say otherwise.
 * `madeIn`: an org-scope row (serving every space) connected from that space. `endUserId`: the
 * connection is that end-user's, not `owner.user`'s.
 */
async function seedGmailConnection(
  owner: TestContext,
  accountId: string,
  opts: {
    shared?: boolean;
    spaceId?: string;
    madeIn?: string;
    integrationId?: string;
    endUserId?: string;
  } = {},
): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: opts.integrationId ?? INTEGRATION_ID,
      authKey: "api",
      accountId,
      label: accountId,
      orgId: owner.orgId,
      spaceId: opts.madeIn ? null : (opts.spaceId ?? owner.defaultSpaceId),
      originSpaceId: opts.madeIn ?? null,
      userId: opts.endUserId ? null : owner.user.id,
      endUserId: opts.endUserId ?? null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: `tok-${accountId}` } }),
      scopesGranted: [],
    })
    .returning({ id: integrationConnections.id });
  await seedShares(row!.id, opts.shared ? [owner.defaultSpaceId] : []);
  return row!.id;
}

async function seedIntegrationWithConnection(ctx: TestContext): Promise<void> {
  await seedGmailIntegration(ctx);
  // A live connection owned by the API key's owner (the resolved actor).
  await db.insert(integrationConnections).values({
    integrationId: INTEGRATION_ID,
    authKey: "api",
    accountId: "acct-1",
    label: "acct-1",
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    userId: ctx.user.id,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "ya29.live-token" } }),
    scopesGranted: [],
  });
}

/** Both proxy paths: outside a run, and for one. */
const BOTH_PATHS = ["credential-proxy:direct", "credential-proxy:call", "agents:run", "runs:read"];

/** A fresh org, as the member the proxy is called by: both paths are open to them. */
async function proxyCallerContext(): Promise<TestContext> {
  return memberHolding(await createTestContext({ orgSlug: "cporg" }), BOTH_PATHS);
}

/** An API key of `ctx.user`: of `scopes`, it carries what its creator holds. */
async function mintProxyKey(ctx: TestContext, scopes: string[] = BOTH_PATHS): Promise<string> {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    createdBy: ctx.user.id,
    scopes,
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
    ctx = await proxyCallerContext();
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
    ctx = await proxyCallerContext();
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
    ctx = await proxyCallerContext();
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

  it("maps a connection under a kid the keyring lacks to 503, flagging nothing", async () => {
    await seedIntegrationWithConnection(ctx);
    await db
      .update(integrationConnections)
      .set({ credentialsEncrypted: `v1:k0gone:${Buffer.alloc(40).toString("base64")}` })
      .where(eq(integrationConnections.integrationId, INTEGRATION_ID));
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
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("encryption_key_unavailable");
    expect(res.headers.get("proxy-status")).toBe("appstrate; error=proxy_configuration_error");
    expect(upstreamCalls).toBe(0);
    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION_ID));
    expect(row!.needsReconnection).toBe(false);
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
      orgId: ctx.orgId,
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
    ctx = await proxyCallerContext();
    await seedIntegrationWithConnection(ctx);
    // Upstream must never be contacted — the auth-method gate fires inside
    // the handler before any credential resolution / fetch.
    mockUpstream(async () => new Response("should not be called", { status: 599 }));
  });
  afterEach(() => restoreFetch());

  it("403s a cookie session even though its member holds both proxy permissions", async () => {
    // The member's role grants both paths' permissions, so the route guard
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
    ctx = await proxyCallerContext();
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
    ctx = await proxyCallerContext();
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

  it("never sends the platform's own request headers upstream: bearer, cookie, markers, version", async () => {
    let sent: Headers | null = null;
    mockUpstream(async (_input, init) => {
      sent = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    });
    const res = await proxyPost(
      {
        Cookie: "better-auth.session_token=platform-session",
        "X-Appstrate-Internal-Dispatch": "not-the-process-secret",
        "X-Appstrate-Trace": "t-1",
        "Appstrate-Version": CURRENT_API_VERSION,
        "Accept-Language": "fr",
      },
      "{}",
    );
    expect(res.status).toBe(200);
    for (const name of [
      "cookie",
      "x-appstrate-internal-dispatch",
      "x-appstrate-trace",
      "appstrate-version",
    ]) {
      expect([name, sent!.get(name)]).toEqual([name, null]);
    }
    // The connection's credential, never the caller's platform bearer.
    expect(sent!.get("authorization")).toBe("Bearer ya29.live-token");
    expect(sent!.get("accept-language")).toBe("fr");
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

describe("POST /api/credential-proxy/proxy — X-Run-Id binds the run's set", () => {
  const AGENT_ID = "@cporg/agent";
  let ctx: TestContext;
  let apiKey: string;
  let colleagueId: string;
  let own1: string;
  let own2: string;
  let shared: string;
  let upstreamAuth: string[];

  async function insertConnection(accountId: string, userId: string, shared = false) {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "api",
        accountId,
        label: accountId,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId,
        credentialsEncrypted: encryptCredentialEnvelope({
          outputs: { api_key: `tok-${accountId}` },
        }),
        scopesGranted: [],
      })
      .returning({ id: integrationConnections.id });
    await seedShares(row!.id, shared ? [ctx.defaultSpaceId] : []);
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
    ctx = await proxyCallerContext();
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

  /** The journal once the route's off-path writes have landed, oldest first. */
  async function journaled() {
    await drainAudits(5_000);
    return db.select().from(connectionCalls).orderBy(asc(connectionCalls.id));
  }

  it("journals a call outside a run: the connection, the key and the principal acting through it", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: BOTH_PATHS,
    });
    const res = await call({
      Authorization: `Bearer ${key.rawKey}`,
      "X-Connection-Id": own1,
      "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5",
    });
    expect(res.status).toBe(200);

    const rows = await journaled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      connectionId: own1,
      integrationId: INTEGRATION_ID,
      ownerType: "user",
      ownerId: ctx.user.id,
      actorType: "user",
      actorId: ctx.user.id,
      apiKeyId: key.id,
      authMethod: "api_key",
      runId: null,
      method: "GET",
      host: "gmail.googleapis.com",
      outcome: "200",
      requestId: res.headers.get("Request-Id"),
    });
    expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("journals every call of a run with its run id, the actor apart from a shared connection's owner", async () => {
    const runId = await runBinding([shared]);
    const session = uuidV4();
    expect((await call({ "X-Run-Id": runId, "X-Session-Id": session })).status).toBe(200);
    expect((await call({ "X-Run-Id": runId, "X-Session-Id": session })).status).toBe(200);

    const rows = await journaled();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        connectionId: shared,
        runId,
        ownerType: "user",
        ownerId: colleagueId,
        actorType: "user",
        actorId: ctx.user.id,
        outcome: "200",
      });
    }
  });

  it("journals a failure after dispatch with its code, never a refusal before anything was sent", async () => {
    mockUpstream(async () => {
      throw new TypeError("fetch failed");
    });
    const runId = await runBinding([shared]);
    expect((await call({ "X-Run-Id": runId })).status).toBe(502);
    // Off the allowlist, a path the key's scopes do not open, and a connection the run did not bind.
    const offList = await call({ "X-Run-Id": runId, "X-Target": "https://evil.example.com/x" });
    expect(offList.status).toBe(403);
    const runOnly = await mintProxyKey(ctx, ["credential-proxy:call"]);
    const noPath = await call({ Authorization: `Bearer ${runOnly}`, "X-Connection-Id": own1 });
    expect(noPath.status).toBe(403);
    expect((await call({ "X-Run-Id": runId, "X-Connection-Id": own1 })).status).toBe(400);

    const rows = await journaled();
    expect(rows.map((row) => [row.connectionId, row.outcome])).toEqual([
      [shared, "upstream_unreachable"],
    ]);
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

    await db
      .delete(integrationConnectionShares)
      .where(eq(integrationConnectionShares.connectionId, shared));

    expect((await call({ "X-Run-Id": runId })).status).toBe(404);
    expect(upstreamAuth).toEqual(["Bearer tok-shared"]);
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
      runOrigin: "remote",
      resolvedConnections: {},
    });
    const res = await call({ "X-Run-Id": run.id });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("credential_not_found");
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
      runOrigin: "remote",
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
});

describe("POST /api/credential-proxy/proxy — one permission per path", () => {
  const AGENT_ID = "@cporg/agent";
  let ctx: TestContext;
  let connectionId: string;
  let upstreamCalls: number;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await proxyCallerContext();
    await seedIntegrationWithConnection(ctx);
    const [connection] = await db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION_ID));
    connectionId = connection!.id;
    await seedPackage({ id: AGENT_ID, orgId: ctx.orgId, type: "agent", source: "local" });
    upstreamCalls = 0;
    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
  });
  afterEach(() => restoreFetch());

  /** An in-flight run of the caller binding their connection; `origin` is who executes it. */
  async function ownRun(origin: "remote" | "platform" = "remote"): Promise<string> {
    const run = await seedRun({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT_ID,
      userId: ctx.user.id,
      status: "running",
      runOrigin: origin,
      resolvedConnections: {
        [INTEGRATION_ID]: [
          { connectionId, source: "member_pin", label: "acct-1", accountId: "acct-1" },
        ],
      },
    });
    return run.id;
  }

  /** A call by a key of the caller carrying `scopes`, for `runId` when given. */
  function call(scopes: string[], runId?: string): Promise<Response> {
    return callAs(ctx, runId, scopes);
  }

  /** A call by a key of `member`: of `scopes`, it carries what they hold. */
  async function callAs(member: TestContext, runId?: string, scopes = BOTH_PATHS) {
    return app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await mintProxyKey(member, scopes)}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
        ...(runId ? { "X-Run-Id": runId } : {}),
      },
    });
  }

  /** The detail of a 403 the platform answered before any upstream contact. */
  async function refusal(res: Response): Promise<string> {
    const body = await expectProblem(res, 403, { code: "forbidden" });
    expect(upstreamCalls).toBe(0);
    return body.detail ?? "";
  }

  it("X-Run-Id + credential-proxy:call: allowed on the caller's own remote run, credential-proxy:direct or not", async () => {
    const runId = await ownRun();
    expect((await call(["credential-proxy:call"], runId)).status).toBe(200);
    expect((await call(BOTH_PATHS, runId)).status).toBe(200);
    expect(upstreamCalls).toBe(2);
  });

  it("X-Run-Id without credential-proxy:call: 403, credential-proxy:direct and agents:run notwithstanding", async () => {
    const scopes = ["credential-proxy:direct", "agents:run", "runs:read"];
    const detail = await refusal(await call(scopes, await ownRun()));
    expect(detail).toContain("credential-proxy:call");
  });

  // Launching a run is not reaching what it bound: a key scoped to `agents:run` registers a
  // remote run, and stops at the route guard when it names it here.
  it("X-Run-Id with agents:run alone: 403, the caller's own remote run included", async () => {
    const detail = await refusal(await call(["agents:run", "runs:read"], await ownRun()));
    expect(detail).toContain("credential-proxy:call|credential-proxy:direct");
  });

  it("no X-Run-Id + credential-proxy:direct: allowed on the caller's own connection, credential-proxy:call or not", async () => {
    expect((await call(["credential-proxy:direct"])).status).toBe(200);
    expect((await call(BOTH_PATHS)).status).toBe(200);
    expect(upstreamCalls).toBe(2);
  });

  it("no X-Run-Id without credential-proxy:direct: 403 naming it and the run path", async () => {
    const detail = await refusal(await call(["credential-proxy:call"]));
    expect(detail).toContain("credential-proxy:direct");
    expect(detail).toContain("X-Run-Id");
  });

  // A key carries what its creator holds, whatever it asks. Of the presets, `admin` alone holds
  // `credential-proxy:direct`; `builder` holds `credential-proxy:call`, `operator` neither.
  it("no X-Run-Id as a `builder`: 403 naming credential-proxy:direct and the run path", async () => {
    const builder = await memberContext(ctx, "member", "builder");
    const detail = await refusal(await callAs(builder));
    expect(detail).toContain("credential-proxy:direct");
    expect(detail).toContain("X-Run-Id");
  });

  it("an `operator` holds neither proxy permission: the route guard refuses, their own run named or not", async () => {
    const operator = await memberContext(ctx, "member", "operator");
    const required = "credential-proxy:call|credential-proxy:direct";
    expect(await refusal(await callAs(operator))).toContain(required);
    const run = await seedRun({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT_ID,
      userId: operator.user.id,
      status: "running",
      runOrigin: "remote",
      resolvedConnections: {
        [INTEGRATION_ID]: [
          { connectionId, source: "member_pin", label: "acct-1", accountId: "acct-1" },
        ],
      },
    });
    expect(await refusal(await callAs(operator, run.id))).toContain(required);
  });

  it("neither permission: the route guard refuses with or without X-Run-Id", async () => {
    const required = "credential-proxy:call|credential-proxy:direct";
    expect(await refusal(await call(["runs:read"]))).toContain(required);
    expect(await refusal(await call(["runs:read"], await ownRun()))).toContain(required);
  });

  it("X-Run-Id naming a run the platform executes: 403, the caller's own included", async () => {
    const detail = await refusal(await call(BOTH_PATHS, await ownRun("platform")));
    expect(detail).toContain("the platform executes");
  });
});

describe("POST /api/credential-proxy/proxy — outside a run, the caller's own connections only", () => {
  const AGENT_ID = "@cporg/agent";
  let ctx: TestContext;
  let colleague: TestContext;
  let apiKey: string;
  let upstreamAuth: string[];

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await proxyCallerContext();
    colleague = await memberContext(ctx, "member");
    apiKey = await mintProxyKey(ctx, ["credential-proxy:direct"]);
    await seedGmailIntegration(ctx);
    upstreamAuth = [];
    mockUpstream(async (_input, init) => {
      upstreamAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
  });
  afterEach(() => restoreFetch());

  function call(extra: Record<string, string> = {}, key = apiKey) {
    return app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
        ...extra,
      },
    });
  }

  async function orgDefault(connectionIds: string[], enforce: boolean) {
    await db.insert(integrationOrgDefaults).values({
      spaceId: ctx.defaultSpaceId,
      integrationId: INTEGRATION_ID,
      connectionIds,
      enforce,
    });
  }

  /** The connection ids `GET /api/credential-proxy/connections` lists for the same key. */
  async function listed(extra: Record<string, string> = {}): Promise<string[]> {
    const res = await app.request("/api/credential-proxy/connections", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        ...extra,
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { data: { connection_id: string }[] };
    return body.data.map((c) => c.connection_id);
  }

  /** A problem body without the two members that name the request. */
  async function problemOf(res: Response): Promise<Record<string, unknown>> {
    const {
      request_id: _requestId,
      instance: _instance,
      ...problem
    } = (await res.json()) as Record<string, unknown>;
    return problem;
  }

  it("nothing named, no own connection: 404 credential_not_found, a colleague's shared one never picked", async () => {
    await seedGmailConnection(colleague, "theirs-shared", { shared: true });
    const body = await expectProblem(await call(), 404, { code: "credential_not_found" });
    expect(body.detail).toContain("through a run (X-Run-Id)");
    expect(upstreamAuth).toEqual([]);
  });

  it("nothing named, one own connection: bound, a colleague's shared one beside it", async () => {
    await seedGmailConnection(colleague, "theirs-shared", { shared: true });
    await seedGmailConnection(ctx, "own-1");
    expect((await call()).status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-own-1"]);
  });

  it("nothing named, several own connections: 409 must_choose_connection over the own rows ONLY", async () => {
    const own1 = await seedGmailConnection(ctx, "own-1");
    const own2 = await seedGmailConnection(ctx, "own-2");
    await seedGmailConnection(colleague, "theirs-shared", { shared: true });

    const res = await call();
    const text = await res.clone().text();
    const body = await expectProblem(res, 409, { code: "must_choose_connection" });
    const [item] = body.errors as { candidate_connections: { id: string }[] }[];
    expect(item!.candidate_connections.map((c) => c.id).sort()).toEqual([own1, own2].sort());
    expect(text).not.toContain("theirs-shared");
    expect(upstreamAuth).toEqual([]);
  });

  it("an own connection named: bound", async () => {
    await seedGmailConnection(ctx, "own-1");
    const own2 = await seedGmailConnection(ctx, "own-2");
    expect((await call({ "X-Connection-Id": own2 })).status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-own-2"]);
  });

  for (const ownConnections of [0, 1]) {
    it(`a connection that is not the caller's named (${ownConnections} own): one 404, whether shared, private or nobody's`, async () => {
      if (ownConnections) await seedGmailConnection(ctx, "own-1");
      const shared = await seedGmailConnection(colleague, "theirs-shared", { shared: true });
      const theirs = await seedGmailConnection(colleague, "theirs-private");

      const bodies = [];
      for (const id of [shared, theirs, crypto.randomUUID()]) {
        const res = await call({ "X-Connection-Id": id });
        expect(res.status).toBe(404);
        expect(res.headers.get("proxy-status")).toBe("appstrate; error=proxy_internal_response");
        bodies.push(JSON.stringify(await problemOf(res)));
      }
      // Byte for byte: nothing tells a colleague's connection, shared or not, from no connection.
      expect(new Set(bodies).size).toBe(1);
      const problem = JSON.parse(bodies[0]!) as { code: string; detail: string };
      expect(problem.code).toBe("credential_not_found");
      expect(problem.detail).toContain("through a run (X-Run-Id)");
      expect(bodies[0]).not.toContain("theirs-");
      expect(upstreamAuth).toEqual([]);
    });
  }

  it("an enforced org default: 403 run_required whatever is named, its members never listed", async () => {
    const own = await seedGmailConnection(ctx, "own-1");
    const shared = await seedGmailConnection(colleague, "theirs-shared", { shared: true });
    await orgDefault([shared], true);

    const named = [undefined, own, shared, crypto.randomUUID()];
    for (const id of named) {
      const res = await call(id ? { "X-Connection-Id": id } : {});
      const text = await res.clone().text();
      await expectProblem(res, 403, { code: "run_required" });
      expect(res.headers.get("proxy-status")).toBe("appstrate; error=http_request_denied");
      expect(text).toContain("X-Run-Id");
      expect(text).not.toContain(shared);
      expect(text).not.toContain("theirs-shared");
    }
    expect(upstreamAuth).toEqual([]);
    await drainAudits(5_000);
    expect(await db.select().from(connectionCalls)).toHaveLength(0);

    // The other path: a run whose kickoff bound the default's member reaches it.
    await seedPackage({ id: AGENT_ID, orgId: ctx.orgId, type: "agent", source: "local" });
    const run = await seedRun({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT_ID,
      userId: ctx.user.id,
      status: "running",
      runOrigin: "remote",
      resolvedConnections: {
        [INTEGRATION_ID]: [
          {
            connectionId: shared,
            source: "org_default_enforced",
            label: "team",
            accountId: "team",
          },
        ],
      },
    });
    const runKey = await mintProxyKey(ctx, ["credential-proxy:call"]);
    const viaRun = await call({ "X-Run-Id": run.id }, runKey);
    expect(viaRun.status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-theirs-shared"]);
  });

  // An org owner or admin is preset `admin` in every space, which holds
  // `credential-proxy:direct`: the permission opens the path, it widens nothing.
  it("an org admin too reaches their own connections only", async () => {
    const admin = await memberContext(ctx, "admin");
    const adminKey = await mintProxyKey(admin, ["credential-proxy:direct"]);
    const mine = await seedGmailConnection(admin, "admin-own");
    const shared = await seedGmailConnection(colleague, "theirs-shared", { shared: true });

    const refused = await call({ "X-Connection-Id": shared }, adminKey);
    await expectProblem(refused, 404, { code: "credential_not_found" });
    expect((await call({}, adminKey)).status).toBe(200);
    expect((await call({ "X-Connection-Id": mine }, adminKey)).status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-admin-own", "Bearer tok-admin-own"]);
  });

  // The rows a run of the caller could bind here, restricted to their own: a block keeps out an
  // own row made elsewhere until it is shared into the space, at the proxy and in the listing.
  it("block_user_connections: an own connection made elsewhere is a 404 until shared into the space, then bound", async () => {
    const elsewhere = await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" });
    await seedSpacePackage(ctx.defaultSpaceId, INTEGRATION_ID, { blockUserConnections: true });
    const own = await seedGmailConnection(ctx, "own-elsewhere", { madeIn: elsewhere.id });

    await expectProblem(await call(), 404, { code: "credential_not_found" });
    await expectProblem(await call({ "X-Connection-Id": own }), 404, {
      code: "credential_not_found",
    });
    expect(await listed()).toEqual([]);
    expect(upstreamAuth).toEqual([]);

    await seedShares(own, [ctx.defaultSpaceId]);
    expect((await call()).status).toBe(200);
    expect((await call({ "X-Connection-Id": own })).status).toBe(200);
    expect(await listed()).toEqual([own]);
    expect(upstreamAuth).toEqual(["Bearer tok-own-elsewhere", "Bearer tok-own-elsewhere"]);
  });

  // `Appstrate-User` on an API key: the actor is the end-user, with the key's permissions.
  it("an end-user reaches the end-user's own connections only, and the key's creator never theirs", async () => {
    const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
    const asEndUser = { "Appstrate-User": endUser.id };
    const theirs = await seedGmailConnection(ctx, "eu-own", { endUserId: endUser.id });
    const creators = await seedGmailConnection(ctx, "creator-own");
    const notFound = { code: "credential_not_found" };

    expect((await call(asEndUser)).status).toBe(200);
    expect((await call({ ...asEndUser, "X-Connection-Id": theirs })).status).toBe(200);
    await expectProblem(await call({ ...asEndUser, "X-Connection-Id": creators }), 404, notFound);
    expect(await listed(asEndUser)).toEqual([theirs]);

    expect((await call()).status).toBe(200);
    await expectProblem(await call({ "X-Connection-Id": theirs }), 404, notFound);
    expect(await listed()).toEqual([creators]);

    expect(upstreamAuth).toEqual([
      "Bearer tok-eu-own",
      "Bearer tok-eu-own",
      "Bearer tok-creator-own",
    ]);
  });

  it("an end-user with no connection of their own gets the 404, the creator's one beside it", async () => {
    const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
    await seedGmailConnection(ctx, "creator-own");
    const res = await call({ "Appstrate-User": endUser.id });
    await expectProblem(res, 404, { code: "credential_not_found" });
    expect(await listed({ "Appstrate-User": endUser.id })).toEqual([]);
    expect(upstreamAuth).toEqual([]);
  });

  it("a soft org default is ignored: the own connection is bound, never the default's", async () => {
    await seedGmailConnection(ctx, "own-1");
    const shared = await seedGmailConnection(colleague, "theirs-shared", { shared: true });
    await orgDefault([shared], false);
    expect((await call()).status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer tok-own-1"]);
  });
});

describe("GET /api/credential-proxy/connections", () => {
  let ctx: TestContext;
  let colleague: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await proxyCallerContext();
    colleague = await memberContext(ctx, "member");
    await seedGmailIntegration(ctx);
    mockUpstream(async () => new Response("should not be called", { status: 599 }));
  });
  afterEach(() => restoreFetch());

  async function list(scopes: string[] = ["credential-proxy:direct"]): Promise<Response> {
    return app.request("/api/credential-proxy/connections", {
      headers: {
        Authorization: `Bearer ${await mintProxyKey(ctx, scopes)}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
      },
    });
  }

  it("requires credential-proxy:direct: credential-proxy:call opens the proxy's run path, not this list", async () => {
    const body = await expectProblem(await list(["credential-proxy:call"]), 403, {
      code: "forbidden",
    });
    expect(body.detail).toContain("credential-proxy:direct");
  });

  it("lists the caller's own usable connections as the proxy serves them, never a colleague's", async () => {
    const own = await seedGmailConnection(ctx, "own-1");
    const dead = await seedGmailConnection(ctx, "own-dead");
    await db
      .update(integrationConnections)
      .set({ needsReconnection: true })
      .where(eq(integrationConnections.id, dead));
    await seedGmailConnection(colleague, "theirs-shared", { shared: true });
    await seedGmailConnection(colleague, "theirs-private");
    // Own, but out of reach here: scoped to another space, or of an integration not active here.
    const otherSpace = await seedSpace({ orgId: ctx.orgId, name: "Other" });
    await seedGmailConnection(ctx, "own-elsewhere", { spaceId: otherSpace.id });
    const INACTIVE = "@cporg/inactive";
    await seedPackage({
      id: INACTIVE,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: gmailManifest(INACTIVE),
    });
    await seedPublishedVersion(INACTIVE, "1.0.0");
    await seedGmailConnection(ctx, "own-inactive", { integrationId: INACTIVE });

    const res = await list();
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    const body = (await res.json()) as {
      object: string;
      data: { connection_id: string }[];
      hasMore: boolean;
    };
    const entry = (connectionId: string, label: string, needsReconnection: boolean) => ({
      integration_package_id: INTEGRATION_ID,
      connection_id: connectionId,
      label,
      auth_key: "api",
      scopes_granted: [],
      authorized_uris: ["https://gmail.googleapis.com/**"],
      allow_all_uris: false,
      needs_reconnection: needsReconnection,
      run_required: false,
    });
    const byId = (a: { connection_id: string }, b: { connection_id: string }) =>
      a.connection_id.localeCompare(b.connection_id);
    expect({ ...body, data: [...body.data].sort(byId) }).toEqual({
      object: "list",
      data: [entry(own, "own-1", false), entry(dead, "own-dead", true)].sort(byId),
      hasMore: false,
    });
    // No credential value, and nothing of a colleague's.
    expect(text).not.toContain("tok-");
    expect(text).not.toContain("theirs-");
  });

  it("never returns a credential value: an entry templated on a credential field stays a template", async () => {
    /** A published integration active in the space, with one `primary` api_key auth. */
    const seedTemplated = async (
      id: string,
      authorizedUris: string[],
      fields: string[],
      variables: string[] = [],
    ) => {
      const strings = (names: string[]) =>
        Object.fromEntries(names.map((name) => [name, { type: "string" }]));
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "integration",
        source: "local",
        homeSpaceId: ctx.defaultSpaceId,
        draftManifest: {
          schema_version: "0.1",
          type: "integration",
          name: id,
          version: "1.0.0",
          display_name: id,
          source: { kind: "local", server: { name: `${id}-server`, version: "^1.0.0" } },
          ...(variables.length > 0
            ? {
                variables: {
                  schema: { type: "object", properties: strings(variables), required: variables },
                },
              }
            : {}),
          auths: {
            primary: {
              type: "api_key",
              authorized_uris: authorizedUris,
              credentials: {
                schema: { type: "object", properties: strings(fields), required: fields },
              },
              delivery: {
                http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" },
              },
            },
          },
        },
      });
      await seedPublishedVersion(id, "1.0.0");
      await db.insert(spacePackages).values({ spaceId: ctx.defaultSpaceId, packageId: id });
    };
    const connect = async (
      id: string,
      outputs: Record<string, string>,
      variables: Record<string, string> = {},
    ) => {
      await db.insert(integrationConnections).values({
        integrationId: id,
        authKey: "primary",
        accountId: "acct",
        label: `conn ${id}`,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs }),
        variables,
        scopesGranted: [],
      });
    };

    // The shape of the shipped webhooks integration: the entry IS the secret URL.
    const HOOK = "@cporg/hook";
    const hookCredential = {
      api_key: "HOOK-APIKEY-SECRET",
      webhook_url:
        "https://hooks.example.com/services/T0SECRET/B0SECRET?key=KEYSECRET&token=TOKSECRET",
    };
    await seedTemplated(HOOK, ["{$credential.webhook_url}"], ["api_key", "webhook_url"]);
    await connect(HOOK, hookCredential);
    // A credential-templated host beside a variable-templated entry and a literal one.
    const TENANT = "@cporg/tenant";
    const tenantCredential = { api_key: "TENANT-APIKEY-SECRET", host: "secret-tenant.example.net" };
    await seedTemplated(
      TENANT,
      [
        "https://{$credential.host}/**",
        "{$variable.base_url}/api/**",
        "https://static.example.org/**",
      ],
      ["api_key", "host"],
      ["base_url"],
    );
    await connect(TENANT, tenantCredential, { base_url: "https://forge.example.com" });

    const res = await list();
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    const body = (await res.json()) as {
      data: { integration_package_id: string; authorized_uris: string[] }[];
    };
    expect(body.data.map((c) => [c.integration_package_id, c.authorized_uris])).toEqual([
      [HOOK, ["{$credential.webhook_url}"]],
      [
        TENANT,
        [
          "https://{$credential.host}/**",
          "https://forge.example.com/api/**",
          "https://static.example.org/**",
        ],
      ],
    ]);
    // No value of any credential field, whole or in part.
    const secrets = [
      ...Object.values(hookCredential),
      ...Object.values(tenantCredential),
      "hooks.example.com",
      "T0SECRET",
      "B0SECRET",
      "KEYSECRET",
      "TOKSECRET",
    ];
    for (const secret of secrets) expect(text).not.toContain(secret);
  });

  it("flags run_required under an enforced org default", async () => {
    const own = await seedGmailConnection(ctx, "own-1");
    const shared = await seedGmailConnection(colleague, "theirs-shared", { shared: true });
    await db.insert(integrationOrgDefaults).values({
      spaceId: ctx.defaultSpaceId,
      integrationId: INTEGRATION_ID,
      connectionIds: [shared],
      enforce: true,
    });

    const body = (await (await list()).json()) as {
      data: { connection_id: string; run_required: boolean }[];
    };
    expect(body.data.map((c) => [c.connection_id, c.run_required])).toEqual([[own, true]]);
  });
});

describe("POST /api/credential-proxy/proxy — a remote run lends what it bound to a launcher holding credential-proxy:call", () => {
  const SVC = "@cporg/svc";
  const AGENT = "@cporg/briefing";

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => restoreFetch());

  it("a builder proxies through their remote run to the enforced default's shared connection; an operator's run lends nothing", async () => {
    const owner = await createTestContext({ orgSlug: "cporg" });
    const spaceId = owner.defaultSpaceId;
    await seedProxyIntegration(
      owner,
      localIntegrationManifest({
        name: SVC,
        version: "1.0.0",
        auths: {
          primary: {
            type: "api_key",
            authorizedUris: ["https://1.1.1.1/**"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
            }),
          },
        },
        tools_policy: { search: {} },
      }),
    );
    // The team's connection: a colleague's, shared into the space and enforced as its default.
    const colleague = await memberContext(owner, "member", "operator");
    const shared = await seedProxyConnection(
      colleague,
      SVC,
      "primary",
      { api_key: "team-token" },
      "team",
    );
    await seedShares(shared, [spaceId]);
    await db
      .insert(integrationOrgDefaults)
      .values({ spaceId, integrationId: SVC, connectionIds: [shared], enforce: true });
    await seedPackage({
      id: AGENT,
      orgId: owner.orgId,
      type: "agent",
      source: "local",
      homeSpaceId: spaceId,
      draftManifest: {
        name: AGENT,
        display_name: "Briefing Agent",
        version: "1.0.0",
        type: "agent",
        description: "Test agent",
        schema_version: "0.1",
        author: "tester",
        timeout: 300,
        dependencies: { skills: {}, mcp_servers: {}, integrations: { [SVC]: "^1.0.0" } },
        integrations_configuration: { [SVC]: { tools: ["search"] } },
      },
      draftContent: "Brief the team.",
    });
    await seedPublishedVersion(AGENT, "1.0.0");
    await db.insert(spacePackages).values({ spaceId, packageId: AGENT });

    const upstreamAuth: string[] = [];
    mockUpstream(async (_input, init) => {
      upstreamAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    /** `member` launches the agent as a remote run with their own key, then calls the proxy. */
    const launchAndProxy = async (member: TestContext) => {
      const headers = {
        Authorization: `Bearer ${await mintProxyKey(member)}`,
        "X-Org-Id": owner.orgId,
        "X-Space-Id": spaceId,
      };
      const launched = await app.request("/api/runs/remote", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          source: { kind: "registry", packageId: AGENT, stage: "published", spec: "1.0.0" },
          spaceId,
          input: {},
        }),
      });
      expect(launched.status, await launched.clone().text()).toBe(201);
      const { id: runId } = (await launched.json()) as { id: string };
      const proxy = (extra: Record<string, string>) =>
        app.request("/api/credential-proxy/proxy", {
          method: "GET",
          headers: {
            ...headers,
            "X-Integration-Id": SVC,
            "X-Target": "https://1.1.1.1/v1/items",
            "X-Session-Id": uuidV4(),
            ...extra,
          },
        });
      return { viaRun: await proxy({ "X-Run-Id": runId }), direct: await proxy({}) };
    };

    // `builder` holds `credential-proxy:call` and no `credential-proxy:direct`: the run lends
    // the shared connection, and outside it the same caller reaches nothing.
    const builder = await launchAndProxy(await memberContext(owner, "member", "builder"));
    expect(builder.viaRun.status, await builder.viaRun.clone().text()).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer team-token"]);
    const direct = await expectProblem(builder.direct, 403, { code: "forbidden" });
    expect(direct.detail).toContain("credential-proxy:direct");

    // `operator` launches runs too (`agents:run`) and holds neither proxy permission: registering
    // a remote run is not a way to the colleague's connection.
    const operator = await launchAndProxy(await memberContext(owner, "member", "operator"));
    for (const res of [operator.viaRun, operator.direct]) {
      const refused = await expectProblem(res, 403, { code: "forbidden" });
      expect(refused.detail).toContain("credential-proxy:call|credential-proxy:direct");
    }
    expect(upstreamAuth).toHaveLength(1);
  });
});

describe("POST /api/credential-proxy/proxy — upstream Set-Cookie is never relayed", () => {
  const COOKIE_INTEGRATION = "@cporg/shop";
  let ctx: TestContext;
  let apiKey: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await proxyCallerContext();
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
    ctx = await proxyCallerContext();
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
  async function expectUnusable(res: Response, header?: string): Promise<void> {
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(res.headers.get("proxy-status")).toBe("appstrate; error=proxy_configuration_error");
    const body = JSON.parse(text) as { code: string; detail: string };
    expect(body.code).toBe("credential_unusable");
    if (header) expect(body.detail.toLowerCase()).toContain(`"${header.toLowerCase()}"`);
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
      await expectUnusable(await call({ "X-Pass": "{{password}}" }));
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

  it("journals a buffered body broken off after a 200 once, as what the caller was answered", async () => {
    const connectionId = await seedProxyConnection(ctx, KEY_INTEGRATION, "api", { api_key: "ok" });
    mockUpstream(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hel"));
          controller.error(new Error("socket closed"));
        },
      });
      return new Response(body, { status: 200 });
    });
    expect((await call()).status).toBe(502);
    await drainAudits(5_000);
    const rows = await db.select().from(connectionCalls);
    expect(rows.map((row) => [row.connectionId, row.outcome])).toEqual([
      [connectionId, "upstream_unreachable"],
    ]);

    // Control: a body read to its end is journaled with the upstream's status, once as well.
    mockUpstream(async () => new Response("hello", { status: 200 }));
    expect((await call()).status).toBe(200);
    await drainAudits(5_000);
    const outcomes = (await db.select().from(connectionCalls)).map((row) => row.outcome);
    expect(outcomes.sort()).toEqual(["200", "upstream_unreachable"]);
  });
});
