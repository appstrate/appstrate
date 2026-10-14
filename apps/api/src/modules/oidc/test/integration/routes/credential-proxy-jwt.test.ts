// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the credential-proxy JWT bearer path.
 *
 * The core route `/api/credential-proxy/proxy` was API-key-only until the
 * remote-backed CLI work. These
 * tests pin the new contract:
 *
 *   1. A device-flow JWT minted by `POST /api/auth/cli/token` authenticates
 *      the caller on the proxy — the auth pipeline's OIDC strategy claims
 *      the request and the route's `ACCEPTED_AUTH_METHODS` allows
 *      `oauth2-instance`.
 *
 *   2. Cookie sessions remain rejected (drive-by CSRF threat model).
 *
 *   3. Garbage bearer values fall all the way through to the final
 *      `Invalid or missing session` 401, not silently to 500.
 *
 *   4. The access rule is the API-key door's (`credential-proxy.test.ts`):
 *      `credential-proxy:call-run` for a run the caller executes,
 *      `credential-proxy:call-own` outside one, on the caller's own connections, and with
 *      both on those shared into the space. The owner of a personal space, which no API key
 *      enters, has no path outside a run there.
 *
 * Injection itself is covered by `credential-proxy-injection.test.ts`. Here we
 * only care that the auth gate lets the right principals in, on the right
 * path, and that the session binding is keyed on the namespaced `user:<id>`
 * principal (not the raw user id, so an API key and a JWT for the same
 * underlying id cannot share a cookie jar).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user as userTable, session as sessionTable } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  memberContext,
  memberHolding,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import { seedPackage, seedRun, seedSpace } from "../../../../../../test/helpers/seed.ts";
import { expectProblem } from "../../../../../../test/helpers/assertions.ts";
import { seedShares } from "../../../../../../test/helpers/connection-shares.ts";
import {
  seedProxyConnection,
  seedProxyIntegration,
} from "../../../../../../test/helpers/credential-proxy-fixtures.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../../../../../test/helpers/integration-manifests.ts";
import oidcModule from "../../../index.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { ensureCliClient } from "../../../services/ensure-cli-client.ts";
import { deviceCode } from "@appstrate/db/schema";
import { overrideJwks } from "../../../services/enduser-token.ts";

const app = getTestApp({ modules: [oidcModule] });

interface Principal {
  userId: string;
  cookie: string;
  orgId: string;
  spaceId: string;
  accessToken: string;
}

/** Mint a device-flow JWT (`oauth2-instance`) for `ctx.user`: the interactive CLI's login. */
async function mintCliToken(ctx: TestContext): Promise<string> {
  // Platform realm is the default for BA's `databaseHooks.user.create.before`
  // but we assert it explicitly to match the cli-token-flow pattern — the
  // device-flow plugin refuses users in non-platform realms.
  await db.update(userTable).set({ realm: "platform" }).where(eq(userTable.id, ctx.user.id));
  await db
    .update(sessionTable)
    .set({ realm: "platform" })
    .where(eq(sessionTable.userId, ctx.user.id));

  // Device-flow dance — code, approve, exchange.
  const codeRes = await app.request("/api/auth/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "appstrate-cli",
      scope: "openid profile email offline_access",
    }),
  });
  expect(codeRes.status).toBe(200);
  const code = (await codeRes.json()) as { device_code: string; user_code: string };

  // BA 1.7: claim the code (GET /device) before approving.
  await app.request(`/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`, {
    headers: { Cookie: ctx.cookie },
  });
  const approveRes = await app.request("/api/auth/device/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: ctx.cookie },
    body: JSON.stringify({ userCode: code.user_code }),
  });
  expect(approveRes.status).toBe(200);

  await db
    .update(deviceCode)
    .set({ lastPolledAt: new Date(Date.now() - 10_000) })
    .where(eq(deviceCode.deviceCode, code.device_code));

  const tokenRes = await app.request("/api/auth/cli/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code.device_code,
      client_id: "appstrate-cli",
    }),
  });
  expect(tokenRes.status).toBe(200);
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

/**
 * Create a user, own-role org + default space, and mint a device-flow
 * JWT for that user. Returns everything a request needs to hit
 * `/api/credential-proxy/proxy`. The owner is preset `admin` in the space,
 * which holds both `credential-proxy:call-run` and `credential-proxy:call-own`.
 */
async function createJwtPrincipal(): Promise<Principal> {
  const ctx = await createTestContext();
  return {
    userId: ctx.user.id,
    cookie: ctx.cookie,
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    accessToken: await mintCliToken(ctx),
  };
}

describe("POST /api/credential-proxy/proxy — auth gate", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwks(null);
    await ensureCliClient();
  });

  it("accepts a device-flow JWT bearer (oauth2-instance) and reaches post-auth validation", async () => {
    const p = await createJwtPrincipal();

    // Omit X-Integration-Id on purpose — a JWT that authenticated successfully
    // lands in the handler body and trips the explicit validation there.
    // If the auth pipeline rejected the JWT we would get 401 / 403
    // instead, never reaching the 400 branch.
    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.accessToken}`,
        "X-Space-Id": p.spaceId,
        "X-Org-Id": p.orgId,
        "X-Target": "https://example.test/echo",
        "X-Session-Id": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string; title?: string };
    const detail = body.detail ?? body.title ?? "";
    expect(detail).toMatch(/X-Integration-Id/i);
  });

  it("rejects cookie sessions with 403 (CSRF threat model)", async () => {
    const p = await createJwtPrincipal();

    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Cookie: p.cookie,
        "X-Space-Id": p.spaceId,
        "X-Org-Id": p.orgId,
        "X-Integration-Id": "@test/example",
        "X-Target": "https://example.test/echo",
        "X-Session-Id": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/auth method/i);
  });

  it("rejects an unknown bearer shape with 401 (falls through the OIDC strategy)", async () => {
    // Not a JWT, not an apst_ key — the OIDC strategy returns null, core
    // Bearer API-key path doesn't match either (no `apst_` prefix), the
    // cookie fallback fails to resolve a session.
    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: "Bearer not-a-real-token",
        "X-Space-Id": "spc_x",
        "X-Integration-Id": "@test/example",
        "X-Target": "https://example.test/echo",
        "X-Session-Id": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(401);
  });

  it("binds the session to the `user:<id>` namespace, not the raw id", async () => {
    // Regression guard: a namespaced principal keeps JWT sessions and
    // API-key sessions from sharing a cookie jar even if the underlying
    // identifiers collide. We prove it by reading the cache directly
    // after a successful proxy call.
    const p = await createJwtPrincipal();
    const sessionId = crypto.randomUUID();

    await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.accessToken}`,
        "X-Space-Id": p.spaceId,
        "X-Org-Id": p.orgId,
        "X-Integration-Id": "@missing/provider",
        "X-Target": "https://example.test/echo",
        "X-Session-Id": sessionId,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    const { getCache } = await import("../../../../../infra/index.ts");
    const cache = await getCache();
    const bound = await cache.get(`cp:session:${sessionId}`);
    expect(bound).toBe(`user:${p.userId}`);
  });
});

describe("POST /api/credential-proxy/proxy — one permission per path, through a JWT", () => {
  const INTEGRATION_ID = "@jwtorg/svc";
  const AGENT_ID = "@jwtorg/agent";
  const realFetch: typeof fetch = globalThis.fetch;
  let owner: TestContext;
  let shared: string;
  let upstreamAuth: string[];
  let tokens: Map<string, string>;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwks(null);
    await ensureCliClient();
    tokens = new Map();
    owner = await createTestContext({ orgSlug: "jwtorg" });
    await seedProxyIntegration(
      owner,
      localIntegrationManifest({
        name: INTEGRATION_ID,
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://1.1.1.1/**"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
            }),
          },
        },
      }),
    );
    await seedPackage({ id: AGENT_ID, orgId: owner.orgId, type: "agent", source: "local" });
    // The team's connection: a colleague's, shared into the space.
    const colleague = await memberContext(owner, "member", "builder");
    shared = await seedProxyConnection(
      colleague,
      INTEGRATION_ID,
      "api",
      { api_key: "team" },
      "team",
    );
    await seedShares(shared, [owner.defaultSpaceId]);
    upstreamAuth = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Stub the integration's upstream only: the token dance above stays on the real fetch. */
  function mockUpstream(): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://1.1.1.1/")) return realFetch(input, init);
      upstreamAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  /** A call by `caller` with their CLI token, minted once per test. */
  async function call(caller: TestContext, extra: Record<string, string> = {}): Promise<Response> {
    const accessToken = tokens.get(caller.user.id) ?? (await mintCliToken(caller));
    tokens.set(caller.user.id, accessToken);
    mockUpstream();
    return app.request("/api/credential-proxy/proxy", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Org-Id": owner.orgId,
        "X-Space-Id": owner.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Target": "https://1.1.1.1/v1/items",
        "X-Session-Id": crypto.randomUUID(),
        ...extra,
      },
    });
  }

  /** An in-flight remote run of `launcher` that bound the team's shared connection. */
  async function remoteRunOf(launcher: TestContext): Promise<string> {
    const run = await seedRun({
      orgId: owner.orgId,
      spaceId: owner.defaultSpaceId,
      packageId: AGENT_ID,
      userId: launcher.user.id,
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
    return run.id;
  }

  it("credential-proxy:call-run alone: refused outside a run, the shared connection reached through a remote run of the caller's", async () => {
    const callRunOnly = await memberHolding(owner, ["credential-proxy:call-run"]);
    const body = await expectProblem(await call(callRunOnly), 403, { code: "forbidden" });
    expect(body.detail).toContain("credential-proxy:call-own");
    expect(upstreamAuth).toEqual([]);

    const res = await call(callRunOnly, { "X-Run-Id": await remoteRunOf(callRunOnly) });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer team"]);
  });

  it("credential-proxy:call-own alone: the caller's own connections only", async () => {
    const member = await memberHolding(owner, ["credential-proxy:call-own"]);
    const refused = await call(member, { "X-Connection-Id": shared });
    const body = await expectProblem(refused, 404, { code: "credential_not_found" });
    expect(body.detail).toContain("also holds credential-proxy:call-run");
    expect(upstreamAuth).toEqual([]);

    const mine = await seedProxyConnection(
      member,
      INTEGRATION_ID,
      "api",
      { api_key: "mine" },
      "mine",
    );
    expect((await call(member)).status).toBe(200);
    expect((await call(member, { "X-Connection-Id": mine })).status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer mine", "Bearer mine"]);
  });

  it("both, as the owner holds them: the shared connection once named, never by the fallback", async () => {
    await expectProblem(await call(owner), 409, { code: "must_choose_connection" });
    expect(upstreamAuth).toEqual([]);

    expect((await call(owner, { "X-Connection-Id": shared })).status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer team"]);
  });

  it("the owner of a personal space has no path outside a run there: 403 naming credential-proxy:call-own", async () => {
    const personal = await seedSpace({
      orgId: owner.orgId,
      name: "Perso",
      ownerUserId: owner.user.id,
      visibility: "private",
    });
    const there = { "X-Space-Id": personal.id };
    const body = await expectProblem(await call(owner, there), 403, { code: "forbidden" });
    expect(body.detail).toContain("credential-proxy:call-own");
    // The control: the run path is open there, so an unknown run is a 404, not this 403.
    await expectProblem(await call(owner, { ...there, "X-Run-Id": "run_doesnotexist0000" }), 404);
    expect(upstreamAuth).toEqual([]);
  });
});
