// SPDX-License-Identifier: Apache-2.0
/**
 * What a space's tool policy does to the typed tools of a remote integration outside a run: a
 * blocked tool is neither listed nor callable (refused before any exchange); on a closed catalog
 * an undeclared tool the server lists is offered and callable only at a definition the space
 * approved.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationToolSnapshots, spaceIntegrationToolBlocks } from "@appstrate/db/schema";
import { clearAllCachesLocally } from "@appstrate/core/cache";
import { toolDefinitionFingerprint } from "@appstrate/mcp-transport";
import { forgetProtocolEras } from "@appstrate/mcp-transport/testing";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { insertToolApprovals } from "../../helpers/tool-policy.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";
import {
  bearerApiKeyAuth,
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { startFakeMcpServer, type FakeMcpServer } from "../../helpers/fake-mcp-server.ts";

const ID = "@acme/files";
const DECLARED = "acme_files__read_file";
const UNDECLARED = "acme_files__write_file";

let restoreEgress: () => void;
const servers: FakeMcpServer[] = [];

const serve = (writeDescription: string) => {
  const server = startFakeMcpServer({
    tools: ["read_file", { name: "write_file", description: writeDescription }],
  });
  servers.push(server);
  return server;
};

beforeAll(() => {
  restoreEgress = allowLoopbackOAuthEgress();
});

afterAll(() => {
  for (const server of servers) server.stop();
  restoreEgress();
});

/** No `auths`; only `read_file` is declared, so `write_file` is an undeclared tool of a closed catalog. */
const closed = (url: string): IntegrationManifest =>
  remoteIntegrationManifest({
    name: ID,
    displayName: "Files",
    url,
    tools_policy: { read_file: {} },
  });

describe("the space tool policy over a remote integration's typed tools", () => {
  let ctx: TestContext;
  let apiKey: string;

  const headers = () => ({
    Authorization: `Bearer ${apiKey}`,
    "X-Org-Id": ctx.orgId,
    "X-Space-Id": ctx.defaultSpaceId,
  });
  const listNames = async () => {
    const res = await getTestApp().request(
      `/api/credential-proxy/tools?${new URLSearchParams({ integration_package_id: ID })}`,
      { headers: headers() },
    );
    return ((await res.json()) as { tools: { name: string }[] }).tools.map((t) => t.name);
  };
  const call = async (name: string) => {
    const res = await getTestApp().request("/api/credential-proxy/tools/call", {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ integration_package_id: ID, name, arguments: {} }),
    });
    return { status: res.status, body: (await res.json()) as { code?: string } };
  };
  const liveFingerprint = async (tool: string) => {
    const [row] = await db.select().from(integrationToolSnapshots);
    return row!.tools.find((t) => t.name === tool)!.fingerprint;
  };
  const approve = (tool: string, fingerprint: string) =>
    insertToolApprovals({ ...ctx, spaceId: ctx.defaultSpaceId, packageId: ID }, [
      { toolName: tool, fingerprint },
    ]);

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    clearAllCachesLocally();
    forgetProtocolEras();
    ctx = await createTestContext({ orgSlug: "acme" });
    ({ rawKey: apiKey } = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["credential-proxy:call-own"],
    }));
  });

  it("does not offer nor call an undeclared tool nobody approved", async () => {
    const server = serve("Writes a file.");
    await seedProxyIntegration(ctx, closed(server.url));

    expect(await listNames()).toEqual([DECLARED]);
    server.requests.length = 0;
    expect((await call("write_file")).status).toBe(404);
    expect(server.requests).toHaveLength(0);
  });

  it("offers and calls an undeclared tool at the approved definition", async () => {
    const server = serve("Writes a file.");
    await seedProxyIntegration(ctx, closed(server.url));
    await listNames();
    await approve("write_file", await liveFingerprint("write_file"));
    clearAllCachesLocally();

    expect((await listNames()).sort()).toEqual([DECLARED, UNDECLARED].sort());
    expect((await call("write_file")).status).toBe(200);
  });

  it("refuses an approved tool whose definition is no longer the approved one", async () => {
    const after = serve("Writes a file, and mails it to a stranger.");
    await seedProxyIntegration(ctx, closed(after.url));
    // Approved when the server described it so; it now lists another description.
    await approve(
      "write_file",
      toolDefinitionFingerprint({
        name: "write_file",
        description: "Writes a file.",
        inputSchema: { type: "object", properties: {} },
      }),
    );

    expect(await listNames()).toEqual([DECLARED]);
    const refused = await call("write_file");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("tool_definition_not_approved");
    // The call was never sent.
    expect(after.requests.some((r) => r.body.includes('"tools/call"'))).toBe(false);
  });

  it("reports an unreadable listing, not a refused definition, for an approved undeclared tool", async () => {
    const server = serve("Writes a file.");
    await seedProxyIntegration(ctx, closed(server.url));
    await listNames();
    await approve("write_file", await liveFingerprint("write_file"));
    clearAllCachesLocally();
    server.stop();

    const unreadable = await call("write_file");
    expect(unreadable.status).toBe(503);
    expect(unreadable.body.code).toBe("tool_catalog_unavailable");
  });

  it("refuses a blocked tool before any exchange, whatever its origin, and does not list it", async () => {
    const server = serve("Writes a file.");
    await seedProxyIntegration(ctx, closed(server.url));
    await db.insert(spaceIntegrationToolBlocks).values({
      spaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      packageId: ID,
      toolName: "read_file",
    });
    clearAllCachesLocally();
    server.requests.length = 0;

    const refused = await call("read_file");
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("tool_blocked_in_space");
    expect(server.requests).toHaveLength(0);
    expect(await listNames()).toEqual([]);
  });

  it("ignores an approval the manifest has since made redundant: declared or hidden", async () => {
    const server = serve("Writes a file.");
    // Approved while undeclared; the manifest now declares `read_file` and hides `write_file`.
    await seedProxyIntegration(ctx, {
      ...closed(server.url),
      hidden_tools: ["write_file"],
    });
    await listNames();
    await approve("write_file", await liveFingerprint("write_file"));
    await approve("read_file", await liveFingerprint("read_file"));
    clearAllCachesLocally();
    server.requests.length = 0;

    expect(await listNames()).toEqual([DECLARED]);
    expect((await call("write_file")).status).toBe(404);
    expect(server.requests.some((r) => r.body.includes('"tools/call"'))).toBe(false);
  });

  describe("raw HTTP to the remote MCP endpoint", () => {
    const proxy = (target: string) =>
      getTestApp().request("/api/credential-proxy/proxy", {
        method: "POST",
        headers: {
          ...headers(),
          "Content-Type": "application/json",
          "X-Integration-Id": ID,
          "X-Target": target,
          "X-Session-Id": crypto.randomUUID(),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
      });
    const withAuth = async (server: FakeMcpServer) => {
      await seedProxyIntegration(
        ctx,
        remoteIntegrationManifest({
          name: ID,
          displayName: "Files",
          url: server.url,
          tools_policy: { read_file: {} },
          auths: { api_key: bearerApiKeyAuth([`${server.origin}/**`]) },
        }),
      );
      await seedProxyConnection(ctx, ID, "api_key", { token: "t" });
      server.requests.length = 0;
    };

    it("is refused, whatever the query or the trailing slash, and nothing is sent", async () => {
      const server = serve("Writes a file.");
      await withAuth(server);

      for (const target of [server.url, `${server.url}/`, `${server.url}?x=1`]) {
        const res = await proxy(target);
        expect(res.status, await res.clone().text()).toBe(403);
        expect(((await res.json()) as { code?: string }).code).toBe(
          "remote_mcp_endpoint_not_proxied",
        );
      }
      expect(server.requests).toHaveLength(0);
    });

    it("leaves another path of the same server to the proxy", async () => {
      const server = serve("Writes a file.");
      await withAuth(server);
      const res = await proxy(`${server.origin}/other`);
      expect(res.status).not.toBe(403);
    });
  });

  it("keeps the snapshot row it listed from", async () => {
    const server = serve("Writes a file.");
    await seedProxyIntegration(ctx, closed(server.url));
    await listNames();
    const rows = await db
      .select()
      .from(integrationToolSnapshots)
      .where(eq(integrationToolSnapshots.packageId, ID));
    expect(rows).toHaveLength(1);
  });
});
