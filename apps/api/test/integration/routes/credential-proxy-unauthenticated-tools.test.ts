// SPDX-License-Identifier: Apache-2.0
/**
 * The typed tools of an unauthenticated remote integration (AFPS §7.2) through
 * `GET /api/credential-proxy/tools` and `POST /api/credential-proxy/tools/call`: listed and called
 * outside a run with no connection, its server (a fake one on loopback, reached through the
 * operator's `EGRESS_ALLOW_INTERNAL_HOSTS` opt-in) reached directly with nothing injected, each
 * operation journaled without a connection, and every refusal answered before any exchange.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { count, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  connectionCalls,
  integrationConnections,
  runs,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { clearAllCachesLocally } from "@appstrate/core/cache";
import { forgetProtocolEras } from "@appstrate/mcp-transport/testing";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { drainAudits } from "../../../src/services/audit.ts";
import { initProxyLimits } from "../../../src/services/proxy-limits.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";
import { bearerApiKeyAuth, seedProxyIntegration } from "../../helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import {
  PNG_IMAGE_CONTENT as IMAGE,
  startFakeMcpServer,
  type FakeMcpServer,
} from "../../helpers/fake-mcp-server.ts";

const ID = "@acme/files";
const TOOL = "acme_files__read_media_file";

let server: FakeMcpServer;
let restoreEgress: () => void;

beforeAll(() => {
  restoreEgress = allowLoopbackOAuthEgress();
  server = startFakeMcpServer({
    tools: [
      { name: "read_media_file", description: "Reads an image.", result: { content: [IMAGE] } },
      "write_file",
    ],
  });
});

afterAll(() => {
  server.stop();
  restoreEgress();
});

/** No `auths`: the integration binds no connection. `write_file` is outside its policy. */
const unauthenticated = (url = server.url): IntegrationManifest =>
  remoteIntegrationManifest({
    name: ID,
    displayName: "Files",
    url,
    tools_policy: { read_media_file: {} },
  });

/** A loopback server answering every request with `respond`, counting what it received. */
function startServer(respond: (req: Request) => Response | Promise<Response>) {
  const received: string[] = [];
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      received.push(req.url);
      return respond(req);
    },
  });
  return {
    url: `http://127.0.0.1:${http.port}/mcp`,
    port: http.port,
    received,
    stop: () => http.stop(true),
  };
}

/** Runs `use` with the operator allowlist and `CREDENTIAL_PROXY_LIMITS` set as given. */
async function withEnv(env: Record<string, string>, use: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  resetEnvCache();
  initProxyLimits();
  try {
    await use();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCache();
    initProxyLimits();
  }
}

interface Tool {
  name: string;
  kind: string;
  remote_name?: string;
  description: string;
  input_schema?: unknown;
  connection_ids: string[];
}
interface Listing {
  tools: Tool[];
  connections: unknown[];
  not_ready: { integration_package_id: string; proxy_connection: { status: string } }[];
  unlisted: { integration_package_id: string; refusal: { code: string; detail: string } }[];
  code?: string;
}

describe("the typed tools of an unauthenticated remote integration", () => {
  let ctx: TestContext;
  let apiKey: string;
  let apiKeyId: string;

  const seedKey = (holder: TestContext, scopes = ["credential-proxy:call-own"]) =>
    seedApiKey({
      orgId: holder.orgId,
      spaceId: holder.defaultSpaceId,
      createdBy: holder.user.id,
      scopes,
    });
  const keyOf = async (holder: TestContext) => (await seedKey(holder)).rawKey;

  const headers = (key: string) => ({
    Authorization: `Bearer ${key}`,
    "X-Org-Id": ctx.orgId,
    "X-Space-Id": ctx.defaultSpaceId,
  });

  const list = async (query: Record<string, string> = {}, key = apiKey) => {
    const res = await getTestApp().request(
      `/api/credential-proxy/tools?${new URLSearchParams(query).toString()}`,
      { headers: headers(key) },
    );
    return { status: res.status, body: (await res.json()) as Listing };
  };

  const call = async (body: Record<string, unknown>, key = apiKey) => {
    const res = await getTestApp().request("/api/credential-proxy/tools/call", {
      method: "POST",
      headers: { ...headers(key), "Content-Type": "application/json" },
      body: JSON.stringify({ integration_package_id: ID, ...body }),
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        result?: { content: unknown[] };
        code?: string;
        detail?: string;
        param?: string;
      },
    };
  };

  const journal = async () => {
    await drainAudits(5_000);
    return db.select().from(connectionCalls).where(eq(connectionCalls.integrationId, ID));
  };

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    clearAllCachesLocally();
    forgetProtocolEras();
    ctx = await createTestContext({ orgSlug: "acme" });
    ({ rawKey: apiKey, id: apiKeyId } = await seedKey(ctx));
    server.requests.length = 0;
  });

  it("is found by a targeted search, by name and by the general one, never as not ready", async () => {
    await seedProxyIntegration(ctx, unauthenticated());

    const targeted = await list({ integration_package_id: ID });
    expect(targeted.status).toBe(200);
    expect(targeted.body.tools).toEqual([
      expect.objectContaining({
        kind: "remote",
        name: TOOL,
        remote_name: "read_media_file",
        description: "Files. Reads an image.",
        input_schema: { type: "object", properties: {} },
        connection_ids: [],
      }),
    ]);
    expect(targeted.body.connections).toEqual([]);
    expect(targeted.body.not_ready).toEqual([]);
    expect(targeted.body.unlisted).toEqual([]);

    const general = await list();
    expect(general.body.tools.map((tool) => tool.name)).toEqual([TOOL]);
    expect(general.body.not_ready).toEqual([]);

    const named = await list({ name: TOOL });
    expect(named.body.tools.map((tool) => tool.name)).toEqual([TOOL]);
    // No request carried a credential.
    expect(server.requests.length).toBeGreaterThan(0);
    expect(server.requests.every((r) => r.headers.get("authorization") === null)).toBe(true);
  });

  it("is called by the listed name with no connection, nothing injected, the image relayed", async () => {
    await seedProxyIntegration(ctx, unauthenticated());
    const { body: listed } = await list({ integration_package_id: ID });
    server.requests.length = 0;

    const { status, body } = await call({ name: listed.tools[0]!.remote_name, arguments: {} });
    expect(status).toBe(200);
    expect(body.result!.content).toEqual([IMAGE]);
    expect(server.requests.some((r) => r.body.includes('"tools/call"'))).toBe(true);
    expect(server.requests.every((r) => r.headers.get("authorization") === null)).toBe(true);

    // No connection and no run was made for it.
    const [connections] = await db.select({ n: count() }).from(integrationConnections);
    const [runRows] = await db.select({ n: count() }).from(runs);
    expect(connections!.n).toBe(0);
    expect(runRows!.n).toBe(0);
  });

  it("journals each operation that reached the server, with no connection and no owner", async () => {
    await seedProxyIntegration(ctx, unauthenticated());
    await list({ integration_package_id: ID });
    // Served from the shared catalog: no exchange, no row.
    await list({ integration_package_id: ID });
    await call({ name: "read_media_file" });

    const rows = await journal();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        connectionId: null,
        ownerType: null,
        ownerId: null,
        actorType: "user",
        actorId: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
        runId: null,
        apiKeyId,
        authMethod: "api_key",
        method: "POST",
        outcome: "200",
        host: "127.0.0.1",
      });
    }

    // The space's governor reads them at its door, without a connection.
    const res = await getTestApp().request("/api/integrations/calls", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { connection_id: string | null; integration_package_id?: string; outcome: string }[];
    };
    expect(data).toHaveLength(2);
    expect(data.every((row) => row.connection_id === null && row.outcome === "200")).toBe(true);
  });

  it("shares the catalog across the organization's callers", async () => {
    await seedProxyIntegration(ctx, unauthenticated());
    await list({ integration_package_id: ID });
    const exchanges = server.requests.length;
    const operator = await memberContext(ctx, "member", "operator");
    const { body } = await list({ integration_package_id: ID }, await keyOf(operator));
    expect(body.tools.map((tool) => tool.name)).toEqual([TOOL]);
    expect(server.requests.length).toBe(exchanges);
  });

  it("lets an operator (`credential-proxy:call-own`) list and call", async () => {
    await seedProxyIntegration(ctx, unauthenticated());
    const operator = await keyOf(await memberContext(ctx, "member", "operator"));
    expect((await list({ integration_package_id: ID }, operator)).body.tools).toHaveLength(1);
    const { status, body } = await call({ name: "read_media_file" }, operator);
    expect(status).toBe(200);
    expect(body.result!.content).toEqual([IMAGE]);
  });

  describe("refusals before any exchange", () => {
    it("in a space that closes the credential proxy", async () => {
      await seedProxyIntegration(ctx, unauthenticated());
      await db
        .update(spaces)
        .set({ credentialProxyOpen: false })
        .where(eq(spaces.id, ctx.defaultSpaceId));

      const listed = await list({ integration_package_id: ID });
      expect([listed.status, listed.body.code]).toEqual([403, "credential_proxy_closed"]);
      const called = await call({ name: "read_media_file" });
      expect([called.status, called.body.code]).toEqual([403, "credential_proxy_closed"]);
      expect(server.requests).toEqual([]);
    });

    it("to a member holding no credential-proxy permission (a runner)", async () => {
      await seedProxyIntegration(ctx, unauthenticated());
      const runner = await keyOf(await memberContext(ctx, "member", "runner"));

      const listed = await list({ integration_package_id: ID }, runner);
      expect([listed.status, listed.body.code]).toEqual([403, "forbidden"]);
      const called = await call({ name: "read_media_file" }, runner);
      expect([called.status, called.body.code]).toEqual([403, "forbidden"]);
      expect(server.requests).toEqual([]);
    });

    it("for an integration switched off in the space", async () => {
      await seedProxyIntegration(ctx, unauthenticated());
      await db.update(spacePackages).set({ enabled: false }).where(eq(spacePackages.packageId, ID));

      expect((await list({ integration_package_id: ID })).status).toBe(404);
      expect((await list()).body.tools).toEqual([]);
      const called = await call({ name: "read_media_file" });
      expect(called.status).toBe(404);
      expect(called.body.detail).toContain("not active in this space");
      expect(server.requests).toEqual([]);
    });

    it("for a tool outside the manifest's policy", async () => {
      await seedProxyIntegration(ctx, unauthenticated());
      const called = await call({ name: "write_file" });
      expect(called.status).toBe(404);
      expect(called.body.detail).toContain("offers no tool named 'write_file'");
      expect(server.requests).toEqual([]);
      // Listed, the server's tool outside the policy is not offered either.
      expect((await list({ integration_package_id: ID })).body.tools.map((t) => t.name)).toEqual([
        TOOL,
      ]);
    });

    it("for a call naming a connection, which the integration binds none of", async () => {
      await seedProxyIntegration(ctx, unauthenticated());
      const called = await call({
        name: "read_media_file",
        connection_id: crypto.randomUUID(),
      });
      expect(called.status).toBe(404);
      expect(called.body.code).toBe("credential_not_found");
      expect(called.body.detail).toBe(
        `Integration '${ID}' declares no authentication and binds no connection: call it without \`connection_id\`.`,
      );
      expect(called.body.param).toBe("connection_id");
      expect(server.requests).toEqual([]);
      expect(await journal()).toEqual([]);
    });

    it("for a server the egress guard refuses (plain http to a host the operator does not trust)", async () => {
      await seedProxyIntegration(ctx, unauthenticated("http://mcp.untrusted.test/mcp"));
      const called = await call({ name: "read_media_file" });
      expect(called.status).toBe(502);
      expect(called.body.detail).toContain("refused by the egress guard");
      const listed = await list({ integration_package_id: ID });
      expect(listed.body.tools).toEqual([]);
      expect(listed.body.unlisted.map((entry) => entry.refusal.code)).toEqual(["bad_gateway"]);
      expect(await journal()).toEqual([]);
    });
  });

  describe("the egress guard on every hop", () => {
    for (const [what, target] of [
      ["to plain http on a host the operator does not trust", "http"],
      ["to a loopback address the operator does not trust", "https"],
    ] as const) {
      it(`refuses a redirect ${what}, its target receiving nothing`, async () => {
        const redirectTarget = startServer(() => new Response("reached"));
        const redirecting = startServer(
          () =>
            new Response(null, {
              status: 307,
              headers: { Location: `${target}://localhost:${redirectTarget.port}/mcp` },
            }),
        );
        try {
          // `localhost` out of the allowlist: untrusted, and resolving to loopback.
          await withEnv({ EGRESS_ALLOW_INTERNAL_HOSTS: "127.0.0.1" }, async () => {
            await seedProxyIntegration(ctx, unauthenticated(redirecting.url));
            const called = await call({ name: "read_media_file" });
            expect(called.status).toBe(502);
            expect(called.body.detail).toBe(
              `The MCP server at ${new URL(redirecting.url).origin} is refused by the egress guard.`,
            );
            const listed = await list({ integration_package_id: ID });
            expect(listed.body.unlisted.map((entry) => entry.refusal.code)).toEqual([
              "bad_gateway",
            ]);
          });
          expect(redirecting.received.length).toBeGreaterThan(0);
          expect(redirectTarget.received).toEqual([]);
          // The first hop was sent: journaled as the refusal of its redirect.
          expect((await journal()).map((row) => row.outcome)).toEqual([
            "blocked_target",
            "blocked_target",
          ]);
        } finally {
          redirecting.stop();
          redirectTarget.stop();
        }
      });
    }
  });

  it("refuses an answer past the proxy's `max_response_bytes`", async () => {
    const big = startFakeMcpServer({
      tools: [
        {
          name: "read_media_file",
          result: { content: [{ type: "text", text: "x".repeat(8192) }] },
        },
      ],
    });
    try {
      await withEnv(
        { CREDENTIAL_PROXY_LIMITS: JSON.stringify({ max_response_bytes: 4096 }) },
        async () => {
          await seedProxyIntegration(ctx, unauthenticated(big.url));
          const called = await call({ name: "read_media_file" });
          expect(called.status).toBe(502);
          expect(called.body.code).toBe("upstream_response_too_large");
          expect(called.body.detail).toContain("more than 4096 bytes");
        },
      );
    } finally {
      big.stop();
    }
  });

  it("resolves an event-stream answer its server keeps open", async () => {
    const sse = startFakeMcpServer({
      tools: [{ name: "read_media_file", result: { content: [IMAGE] } }],
      sse: true,
    });
    // In front of it: the same answers, each event stream left open once relayed.
    const held = startServer(async (req) => {
      const res = await fetch(sse.url, {
        method: req.method,
        headers: req.headers,
        body: await req.text(),
      });
      if (!res.headers.get("content-type")?.includes("text/event-stream")) return res;
      const reader = res.body!.getReader();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) return new Promise<void>(() => {});
            controller.enqueue(value);
          },
        }),
        { status: res.status, headers: res.headers },
      );
    });
    try {
      await seedProxyIntegration(ctx, unauthenticated(held.url));
      const started = Date.now();
      const called = await call({ name: "read_media_file" });
      expect(called.status).toBe(200);
      expect(called.body.result!.content).toEqual([IMAGE]);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      held.stop();
      sse.stop();
    }
  });

  it("answers a server's challenge as the integration unavailable, flagging nothing", async () => {
    const guarded = startFakeMcpServer({ tools: ["read_media_file"], bearer: "nope" });
    try {
      await seedProxyIntegration(ctx, unauthenticated(guarded.url));

      const called = await call({ name: "read_media_file" });
      expect(called.status).toBe(502);
      expect(called.body.code).toBe("bad_gateway");
      expect(called.body.detail).toContain("declares no authentication");
      const listed = await list({ integration_package_id: ID });
      expect(listed.body.unlisted).toEqual([
        expect.objectContaining({
          integration_package_id: ID,
          refusal: expect.objectContaining({ code: "bad_gateway" }),
        }),
      ]);
      expect(listed.body.not_ready).toEqual([]);
      expect(guarded.authorizations.every((a) => a === null)).toBe(true);
      const [connections] = await db.select({ n: count() }).from(integrationConnections);
      expect(connections!.n).toBe(0);
      expect((await journal()).map((row) => row.outcome)).toContain("401");
    } finally {
      guarded.stop();
    }
  });

  it("keeps the connection path for an integration declaring an auth the caller has no connection of", async () => {
    await seedProxyIntegration(
      ctx,
      remoteIntegrationManifest({
        name: ID,
        url: server.url,
        tools_policy: { read_media_file: {} },
        auths: { api_key: bearerApiKeyAuth([`${server.origin}/**`]) },
      }),
    );

    const listed = await list();
    expect(listed.body.tools).toEqual([]);
    expect(listed.body.not_ready).toEqual([
      expect.objectContaining({
        integration_package_id: ID,
        proxy_connection: expect.objectContaining({ status: "none" }),
      }),
    ]);
    const called = await call({ name: "read_media_file" });
    expect(called.status).not.toBe(200);
    expect(called.body.code).toBe("credential_not_found");
    expect(server.requests).toEqual([]);
  });
});
