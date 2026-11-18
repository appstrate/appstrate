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
import { drainAudits } from "../../../src/services/audit.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";
import { bearerApiKeyAuth, seedProxyIntegration } from "../../helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { startFakeMcpServer, type FakeMcpServer } from "../../helpers/fake-mcp-server.ts";

const ID = "@acme/files";
const TOOL = "acme_files__read_media_file";
/** A 1×1 transparent PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const IMAGE = { type: "image" as const, data: PNG, mimeType: "image/png" };

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
  ({
    type: "integration",
    schema_version: "0.3",
    name: ID,
    version: "1.0.0",
    display_name: "Files",
    source: { kind: "remote", remote: { url, transport: "streamable-http" } },
    tools_policy: { read_media_file: {} },
  }) as unknown as IntegrationManifest;

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

  const keyOf = async (holder: TestContext, scopes = ["credential-proxy:call-own"]) =>
    (
      await seedApiKey({
        orgId: holder.orgId,
        spaceId: holder.defaultSpaceId,
        createdBy: holder.user.id,
        scopes,
      })
    ).rawKey;

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
    apiKey = await keyOf(ctx);
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
        outcome: "200",
        host: "127.0.0.1",
      });
      expect(row.apiKeyId).not.toBeNull();
    }
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

      expect((await list({ integration_package_id: ID }, runner)).status).toBe(403);
      expect((await call({ name: "read_media_file" }, runner)).status).toBe(403);
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
