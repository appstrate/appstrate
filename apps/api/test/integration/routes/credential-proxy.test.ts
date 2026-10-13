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
 *   - one permission per path: `credential-proxy:call-run` with `X-Run-Id` (the caller's own
 *     in-flight run, executed by the caller), `credential-proxy:call-own` without
 *   - `X-Run-Id` confines the call to the run's bound connections; without it the caller's
 *     own connections are reachable, and with both permissions those usable in the space
 *   - `GET /api/credential-proxy/connections` lists what a call without a run reaches
 *   - upstream `Set-Cookie` never relayed; the server-side jar keeps continuity
 *   - the call journal: a row per call that may have sent the credential (the
 *     upstream answered, or the call failed after dispatch), none for a refusal
 *   - cookie-session rejection by the `ACCEPTED_AUTH_METHODS` gate → 403
 *
 * Auth is a Bearer API key — cookie sessions are refused by design and the
 * route only accepts API keys / device-flow JWTs (the JWT door is covered in
 * `modules/oidc/test/integration/routes/credential-proxy-jwt.test.ts`). The
 * caller is an org member holding both proxy permissions through a custom space
 * role; a key's `scopes` narrow it to one of them.
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

// The route journals off the response path: no late insert reaches the next case's row counts.
afterEach(async () => {
  await drainAudits(5_000);
});

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

/** The Gmail integration and a live connection of the key's owner (the resolved actor); its id. */
async function seedIntegrationWithConnection(ctx: TestContext): Promise<string> {
  await seedProxyIntegration(ctx, gmailManifest());
  return seedProxyConnection(ctx, INTEGRATION_ID, "api", { api_key: "ya29.live-token" });
}

/** An integration with one `primary` api_key auth whose credential holds `fields`. */
const templated = (name: string, authorizedUris: string[], fields: string[]) =>
  localIntegrationManifest({
    name,
    auths: {
      primary: {
        type: "api_key",
        authorizedUris,
        credentialFields: fields,
        requiredCredentialFields: fields,
        delivery: httpHeaderDelivery({ name: "X-Api-Key", field: "api_key" }),
      },
    },
  });

/** The Gmail integration's org default in the context's default space. */
async function orgDefault(ctx: TestContext, connectionIds: string[], enforce: boolean) {
  await db.insert(integrationOrgDefaults).values({
    spaceId: ctx.defaultSpaceId,
    integrationId: INTEGRATION_ID,
    connectionIds,
    enforce,
  });
}

/** Both proxy paths: outside a run, and for one. */
const BOTH_PATHS = [
  "credential-proxy:call-own",
  "credential-proxy:call-run",
  "agents:run",
  "runs:read",
];

/** The run path alone. */
const RUN_PATH = ["credential-proxy:call-run", "agents:run", "runs:read"];

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
    // Matches the bearer-only gate's verbatim message (`lib/bearer-only.ts`).
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

  it("never sends upstream its own control headers, X-Org-Id included, nor the platform's request headers: bearer, cookie, markers, version", async () => {
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
        "X-Custom": "kept",
      },
      "{}",
    );
    expect(res.status).toBe(200);
    for (const name of [
      "x-org-id",
      "x-space-id",
      "x-integration-id",
      "x-target",
      "x-session-id",
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

describe("POST /api/credential-proxy/proxy — X-Run-Id binds the run's set", () => {
  const AGENT_ID = "@cporg/agent";
  let ctx: TestContext;
  let apiKey: string;
  let colleagueId: string;
  let own1: string;
  let own2: string;
  let shared: string;
  let upstreamAuth: string[];

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
    await seedProxyIntegration(ctx, gmailManifest());
    await seedPackage({ id: AGENT_ID, orgId: ctx.orgId, type: "agent", source: "local" });
    const colleague = { ...ctx, user: await createTestUser() };
    colleagueId = colleague.user.id;
    own1 = await seedGmailConnection(ctx, "own-1");
    own2 = await seedGmailConnection(ctx, "own-2");
    shared = await seedGmailConnection(colleague, "shared", { shared: true });
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
  });

  it("journals a streamed response once, with the upstream's status", async () => {
    const res = await call({ "X-Connection-Id": own1, "X-Stream-Response": "1" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");

    const rows = await journaled();
    expect(rows.map((row) => [row.connectionId, row.outcome])).toEqual([[own1, "200"]]);
  });

  it("journals a target templated on a credential field as the template, never the value", async () => {
    const HOOK = "@cporg/hook";
    await seedProxyIntegration(
      ctx,
      templated(HOOK, ["{$credential.webhook_url}"], ["api_key", "webhook_url"]),
    );
    // The secret URL sits on a literal address: the proxy resolves the host before dispatch.
    const hook = await seedProxyConnection(ctx, HOOK, "primary", {
      api_key: "HOOK-APIKEY-SECRET",
      webhook_url: "https://1.1.1.1/services/T0SECRET?key=KEYSECRET",
    });
    const res = await call({ "X-Integration-Id": HOOK, "X-Target": "{{webhook_url}}" });
    expect(res.status).toBe(200);

    const rows = await journaled();
    expect(rows.map((row) => [row.connectionId, row.host, row.outcome])).toEqual([
      [hook, "{{webhook_url}}", "200"],
    ]);
    expect(rows[0]!.host).not.toContain("1.1.1.1");
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
    const runOnly = await mintProxyKey(ctx, ["credential-proxy:call-run"]);
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
    connectionId = await seedIntegrationWithConnection(ctx);
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
  async function call(scopes: string[], runId?: string): Promise<Response> {
    return app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await mintProxyKey(ctx, scopes)}`,
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

  it("X-Run-Id + credential-proxy:call-run: allowed on the caller's own remote run, credential-proxy:call-own or not", async () => {
    const runId = await ownRun();
    expect((await call(["credential-proxy:call-run"], runId)).status).toBe(200);
    expect((await call(BOTH_PATHS, runId)).status).toBe(200);
    expect(upstreamCalls).toBe(2);
  });

  it("X-Run-Id without credential-proxy:call-run: 403, credential-proxy:call-own and agents:run notwithstanding", async () => {
    const scopes = ["credential-proxy:call-own", "agents:run", "runs:read"];
    const detail = await refusal(await call(scopes, await ownRun()));
    expect(detail).toContain("credential-proxy:call-run");
  });

  it("no X-Run-Id without credential-proxy:call-own: 403 naming it and the run path", async () => {
    const detail = await refusal(await call(["credential-proxy:call-run"]));
    expect(detail).toContain("credential-proxy:call-own");
    expect(detail).toContain("X-Run-Id");
  });

  it("neither permission: the route guard refuses with or without X-Run-Id", async () => {
    const required = "credential-proxy:call-run|credential-proxy:call-own";
    expect(await refusal(await call(["runs:read"]))).toContain(required);
    expect(await refusal(await call(["runs:read"], await ownRun()))).toContain(required);
  });

  it("X-Run-Id naming a run the platform executes: 403, the caller's own included", async () => {
    const detail = await refusal(await call(BOTH_PATHS, await ownRun("platform")));
    expect(detail).toContain("the platform executes");
  });
});

describe("POST /api/credential-proxy/proxy — outside a run with credential-proxy:call-own alone, the caller's own connections only", () => {
  let ctx: TestContext;
  let colleague: TestContext;
  let apiKey: string;
  let upstreamAuth: string[];

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await proxyCallerContext();
    colleague = await memberContext(ctx, "member");
    apiKey = await mintProxyKey(ctx, ["credential-proxy:call-own"]);
    await seedProxyIntegration(ctx, gmailManifest());
    upstreamAuth = [];
    mockUpstream(async (_input, init) => {
      upstreamAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
  });
  afterEach(() => restoreFetch());

  function call(extra: Record<string, string> = {}) {
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
    expect(body.detail).toContain("also holds credential-proxy:call-run");
    expect(upstreamAuth).toEqual([]);
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
      expect(problem.detail).toContain("also holds credential-proxy:call-run");
      expect(bodies[0]).not.toContain("theirs-");
      expect(upstreamAuth).toEqual([]);
    });
  }

  it("an enforced org default: 403 run_required whatever is named, its members never listed", async () => {
    const own = await seedGmailConnection(ctx, "own-1");
    const shared = await seedGmailConnection(colleague, "theirs-shared", { shared: true });
    await orgDefault(ctx, [shared], true);

    const named = [undefined, own, shared, crypto.randomUUID()];
    for (const id of named) {
      const res = await call(id ? { "X-Connection-Id": id } : {});
      const text = await res.clone().text();
      await expectProblem(res, 403, { code: "run_required" });
      expect(res.headers.get("proxy-status")).toBe("appstrate; error=http_request_denied");
      expect(text).toContain("also holds credential-proxy:call-run");
      expect(text).not.toContain(shared);
      expect(text).not.toContain("theirs-shared");
    }
    expect(upstreamAuth).toEqual([]);
    await drainAudits(5_000);
    expect(await db.select().from(connectionCalls)).toHaveLength(0);
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

  it("an end-user under a key holding both permissions reaches a member's shared connection, never the creator's unshared one", async () => {
    const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
    const both = await mintProxyKey(ctx, [
      "credential-proxy:call-own",
      "credential-proxy:call-run",
    ]);
    const asEndUser = { Authorization: `Bearer ${both}`, "Appstrate-User": endUser.id };
    const shared = await seedGmailConnection(colleague, "theirs-shared", { shared: true });
    const creators = await seedGmailConnection(ctx, "creator-own");

    expect((await call({ ...asEndUser, "X-Connection-Id": shared })).status).toBe(200);
    await expectProblem(await call({ ...asEndUser, "X-Connection-Id": creators }), 404, {
      code: "credential_not_found",
    });
    expect(upstreamAuth).toEqual(["Bearer tok-theirs-shared"]);

    await drainAudits(5_000);
    const rows = await db.select().from(connectionCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId: shared,
      actorType: "end_user",
      actorId: endUser.id,
      ownerType: "user",
      ownerId: colleague.user.id,
    });
  });
});

describe("POST /api/credential-proxy/proxy — outside a run, both proxy permissions reach the connections usable in the space", () => {
  let ctx: TestContext;
  let colleague: TestContext;
  let keys: Record<Caller, string>;
  let upstreamAuth: string[];

  type Caller = "both" | "call-own alone";
  type Connection = "own" | "own2" | "shared" | "shared2" | "private";
  const LABELS: Record<Connection, string> = {
    own: "own-1",
    own2: "own-2",
    shared: "theirs-shared",
    shared2: "theirs-shared-2",
    private: "theirs-private",
  };

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await proxyCallerContext();
    colleague = await memberContext(ctx, "member");
    keys = {
      // Exactly the two permissions: no `agents:run`, so this caller can launch no run.
      both: await mintProxyKey(ctx, ["credential-proxy:call-own", "credential-proxy:call-run"]),
      "call-own alone": await mintProxyKey(ctx, ["credential-proxy:call-own"]),
    };
    await seedProxyIntegration(ctx, gmailManifest());
    upstreamAuth = [];
    mockUpstream(async (_input, init) => {
      upstreamAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
  });
  afterEach(() => restoreFetch());

  /**
   * The colleague's connections, `shared` (two unless stated) into the space and one not, and
   * `owned` of the caller's.
   */
  async function seedConnections(
    owned: 0 | 1 | 2 = 1,
    shared: 1 | 2 = 2,
  ): Promise<Record<Connection, string>> {
    return {
      own: owned > 0 ? await seedGmailConnection(ctx, LABELS.own) : crypto.randomUUID(),
      own2: owned > 1 ? await seedGmailConnection(ctx, LABELS.own2) : crypto.randomUUID(),
      shared: await seedGmailConnection(colleague, LABELS.shared, { shared: true }),
      shared2:
        shared > 1
          ? await seedGmailConnection(colleague, LABELS.shared2, { shared: true })
          : crypto.randomUUID(),
      private: await seedGmailConnection(colleague, LABELS.private),
    };
  }

  function call(caller: Caller, connectionId?: string) {
    return app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${keys[caller]}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        "X-Session-Id": uuidV4(),
        ...(connectionId ? { "X-Connection-Id": connectionId } : {}),
      },
    });
  }

  /** What a call answers: the connection it used, or the platform's refusal. */
  type Answer = { uses: Connection } | { status: number; code: string; candidates?: Connection[] };

  // `call-own alone` is listed where no test of the describe above pins its answer.
  const ROWS: {
    situation: string;
    /** The caller's own connections; one unless stated. */
    owned?: 0 | 2;
    /** A single connection is shared into the space, where the fallback could bind it. */
    oneShared?: true;
    orgDefault?: { members: Connection[]; enforce: boolean };
    named?: Connection;
    answers: Partial<Record<Caller, Answer>>;
  }[] = [
    {
      situation: "one own connection, none named",
      answers: { both: { uses: "own" }, "call-own alone": { uses: "own" } },
    },
    {
      situation: "a connection shared into the space, named",
      named: "shared",
      answers: { both: { uses: "shared" } },
    },
    {
      situation: "no own connection, a shared one named",
      owned: 0,
      named: "shared",
      answers: { both: { uses: "shared" } },
    },
    {
      situation: "no own connection, a single shared one, none named",
      owned: 0,
      oneShared: true,
      answers: { both: { status: 409, code: "must_choose_connection", candidates: ["shared"] } },
    },
    {
      situation: "several own connections, none named",
      owned: 2,
      answers: {
        both: {
          status: 409,
          code: "must_choose_connection",
          candidates: ["own", "own2", "shared", "shared2"],
        },
      },
    },
    {
      situation: "a colleague's connection not shared into the space, named",
      named: "private",
      answers: { both: { status: 404, code: "credential_not_found" } },
    },
    {
      situation: "an enforced default of one member, none named",
      orgDefault: { members: ["shared"], enforce: true },
      answers: { both: { uses: "shared" } },
    },
    {
      situation: "an enforced default, an own connection outside it named",
      orgDefault: { members: ["shared"], enforce: true },
      named: "own",
      answers: { both: { status: 400, code: "connection_not_in_org_default" } },
    },
    {
      situation: "an enforced default of several members, none named",
      orgDefault: { members: ["shared", "shared2"], enforce: true },
      answers: {
        both: { status: 409, code: "must_choose_connection", candidates: ["shared", "shared2"] },
      },
    },
    {
      situation: "a soft default, none named",
      orgDefault: { members: ["shared"], enforce: false },
      answers: { both: { uses: "shared" }, "call-own alone": { uses: "own" } },
    },
    {
      situation: "a soft default, an own connection named",
      orgDefault: { members: ["shared"], enforce: false },
      named: "own",
      answers: { both: { uses: "own" } },
    },
    {
      situation: "an org default naming a connection not shared into the space, none named",
      orgDefault: { members: ["private"], enforce: false },
      answers: { both: { status: 409, code: "pinned_connection_unavailable" } },
    },
  ];

  for (const row of ROWS) {
    for (const [caller, answer] of Object.entries(row.answers) as [Caller, Answer][]) {
      const outcome =
        "uses" in answer ? `200 with ${answer.uses}` : `${answer.status} ${answer.code}`;
      it(`${caller} — ${row.situation}: ${outcome}`, async () => {
        const ids = await seedConnections(row.owned, row.oneShared ? 1 : 2);
        if (row.orgDefault) {
          await orgDefault(
            ctx,
            row.orgDefault.members.map((member) => ids[member]),
            row.orgDefault.enforce,
          );
        }

        const res = await call(caller, row.named && ids[row.named]);

        if ("uses" in answer) {
          expect(res.status, await res.clone().text()).toBe(200);
          expect(upstreamAuth).toEqual([`Bearer tok-${LABELS[answer.uses]}`]);
          return;
        }
        const body = await expectProblem(res, answer.status, { code: answer.code });
        expect(upstreamAuth).toEqual([]);
        if (answer.candidates) {
          const [item] = body.errors as { candidate_connections: { id: string }[] }[];
          expect(item!.candidate_connections.map((c) => c.id).sort()).toEqual(
            answer.candidates.map((candidate) => ids[candidate]).sort(),
          );
        }
      });
    }
  }

  it("journals a shared connection's call with its owner, apart from the caller", async () => {
    const ids = await seedConnections();
    expect((await call("both", ids.shared)).status).toBe(200);

    await drainAudits(5_000);
    const rows = await db.select().from(connectionCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId: ids.shared,
      runId: null,
      ownerType: "user",
      ownerId: colleague.user.id,
      actorType: "user",
      actorId: ctx.user.id,
      outcome: "200",
    });
    expect(colleague.user.id).not.toBe(ctx.user.id);
  });

  /** The problem bodies of `call("both", id)` for each id, without the members naming the request. */
  async function refusals(connectionIds: string[]): Promise<string[]> {
    const bodies = [];
    for (const id of connectionIds) {
      const {
        request_id: _requestId,
        instance: _instance,
        ...problem
      } = (await (await call("both", id)).json()) as Record<string, unknown>;
      bodies.push(JSON.stringify(problem));
    }
    return bodies;
  }

  it("answers a connection out of reach as an unknown id, byte for byte, under an enforced default too", async () => {
    const ids = await seedConnections();
    const outOfReach = [ids.private, crypto.randomUUID()];

    const notFound = await refusals(outOfReach);
    expect(new Set(notFound).size).toBe(1);
    expect(JSON.parse(notFound[0]!)).toMatchObject({ status: 404, code: "credential_not_found" });

    await orgDefault(ctx, [ids.shared], true);
    const outsideDefault = await refusals([ids.own, ...outOfReach]);
    expect(new Set(outsideDefault).size).toBe(1);
    expect(JSON.parse(outsideDefault[0]!)).toMatchObject({
      status: 400,
      code: "connection_not_in_org_default",
    });
    for (const body of [...notFound, ...outsideDefault]) expect(body).not.toContain("theirs-");
    expect(upstreamAuth).toEqual([]);
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
    await seedProxyIntegration(ctx, gmailManifest());
    mockUpstream(async () => new Response("should not be called", { status: 599 }));
  });
  afterEach(() => restoreFetch());

  async function list(scopes: string[] = ["credential-proxy:call-own"]): Promise<Response> {
    return app.request("/api/credential-proxy/connections", {
      headers: {
        Authorization: `Bearer ${await mintProxyKey(ctx, scopes)}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
      },
    });
  }

  it("requires credential-proxy:call-own: credential-proxy:call-run opens the proxy's run path, not this list", async () => {
    const body = await expectProblem(await list(["credential-proxy:call-run"]), 403, {
      code: "forbidden",
    });
    expect(body.detail).toContain("credential-proxy:call-own");
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
      owned_by_actor: true,
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
    // The shape of the shipped webhooks integration: the entry IS the secret URL.
    const HOOK = "@cporg/hook";
    const hookCredential = {
      api_key: "HOOK-APIKEY-SECRET",
      webhook_url:
        "https://hooks.example.com/services/T0SECRET/B0SECRET?key=KEYSECRET&token=TOKSECRET",
    };
    await seedProxyIntegration(
      ctx,
      templated(HOOK, ["{$credential.webhook_url}"], ["api_key", "webhook_url"]),
    );
    await seedProxyConnection(ctx, HOOK, "primary", hookCredential);
    // A credential-templated host beside a variable-templated entry and a literal one.
    const TENANT = "@cporg/tenant";
    const tenantCredential = { api_key: "TENANT-APIKEY-SECRET", host: "secret-tenant.example.net" };
    await seedProxyIntegration(ctx, {
      ...templated(
        TENANT,
        [
          "https://{$credential.host}/**",
          "{$variable.base_url}/api/**",
          "https://static.example.org/**",
        ],
        ["api_key", "host"],
      ),
      variables: {
        schema: {
          type: "object",
          properties: { base_url: { type: "string" } },
          required: ["base_url"],
        },
      },
    });
    const tenant = await seedProxyConnection(ctx, TENANT, "primary", tenantCredential);
    await db
      .update(integrationConnections)
      .set({ variables: { base_url: "https://forge.example.com" } })
      .where(eq(integrationConnections.id, tenant));

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

  /** Each listed row as `[connection_id, owned_by_actor, run_required]`, sorted by id. */
  async function listedFor(scopes: string[]): Promise<[string, boolean, boolean][]> {
    const res = await list(scopes);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      data: { connection_id: string; owned_by_actor: boolean; run_required: boolean }[];
    };
    return body.data
      .map((c): [string, boolean, boolean] => [c.connection_id, c.owned_by_actor, c.run_required])
      .sort(([a], [b]) => a.localeCompare(b));
  }
  const sorted = (rows: [string, boolean, boolean][]) =>
    [...rows].sort(([a], [b]) => a.localeCompare(b));

  it("lists what a call would accept: own alone, or with both permissions the shared rows too, an enforced default's members only", async () => {
    const own = await seedGmailConnection(ctx, "own-1");
    const shared = await seedGmailConnection(colleague, "theirs-shared", { shared: true });
    const shared2 = await seedGmailConnection(colleague, "theirs-shared-2", { shared: true });
    await seedGmailConnection(colleague, "theirs-private");
    const ownAlone = ["credential-proxy:call-own"];

    expect(await listedFor(ownAlone)).toEqual([[own, true, false]]);
    expect(await listedFor(BOTH_PATHS)).toEqual(
      sorted([
        [own, true, false],
        [shared, false, false],
        [shared2, false, false],
      ]),
    );

    // Soft: every row stays nameable. Enforced: naming a row outside the default is a 400.
    await orgDefault(ctx, [shared], false);
    expect(await listedFor(BOTH_PATHS)).toHaveLength(3);
    await db.update(integrationOrgDefaults).set({ enforce: true });
    expect(await listedFor(BOTH_PATHS)).toEqual([[shared, false, false]]);
    expect(await listedFor(ownAlone)).toEqual([[own, true, true]]);
  });
});

describe("POST /api/credential-proxy/proxy — a remote run lends what it bound to a launcher holding credential-proxy:call-run", () => {
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
        Authorization: `Bearer ${await mintProxyKey(member, RUN_PATH)}`,
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
      return { viaRun: await proxy({ "X-Run-Id": runId }), outsideRun: await proxy({}) };
    };

    // A builder's key carrying `credential-proxy:call-run` and no `credential-proxy:call-own`: the
    // run lends the shared connection, and outside it the same key reaches nothing.
    const builder = await launchAndProxy(await memberContext(owner, "member", "builder"));
    expect(builder.viaRun.status, await builder.viaRun.clone().text()).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer team-token"]);
    const refusal = await expectProblem(builder.outsideRun, 403, { code: "forbidden" });
    expect(refusal.detail).toContain("credential-proxy:call-own");

    // `operator` launches runs too (`agents:run`) and holds neither proxy permission: registering
    // a remote run is not a way to the colleague's connection.
    const operator = await launchAndProxy(await memberContext(owner, "member", "operator"));
    for (const res of [operator.viaRun, operator.outsideRun]) {
      const refused = await expectProblem(res, 403, { code: "forbidden" });
      expect(refused.detail).toContain("credential-proxy:call-run|credential-proxy:call-own");
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

  it("answers a body broken off after the headers as upstream_unreachable, not a 500, journaled once as such", async () => {
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
    const res = await call();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe("upstream_unreachable");
    expect(body.detail).toBe("1.1.1.1 could not be reached");
    await drainAudits(5_000);
    const rows = await db.select().from(connectionCalls);
    expect(rows.map((row) => [row.connectionId, row.outcome])).toEqual([
      [connectionId, "upstream_unreachable"],
    ]);
  });
});
