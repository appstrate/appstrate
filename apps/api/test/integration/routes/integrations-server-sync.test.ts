// SPDX-License-Identifier: Apache-2.0
/**
 * `POST /api/integrations/{packageId}/discover` at the route boundary: a remote integration's
 * MCP server on loopback (reached through the operator's `EGRESS_ALLOW_INTERNAL_HOSTS` opt-in),
 * called through the credential proxy with the caller's connection.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  connectionCalls,
  integrationConnectionShares,
  integrationOrgDefaults,
  packages,
  spacePackages,
} from "@appstrate/db/schema";
import { drainAudits } from "../../../src/services/audit.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import {
  authHeaders,
  createTestContext,
  memberHolding,
  type TestContext,
} from "../../helpers/auth.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";
import {
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  localIntegrationManifest,
  remoteIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
import { forgetProtocolEras } from "@appstrate/mcp-transport/testing";
import {
  startFakeMcpServer,
  type FakeMcpServer,
  type FakeMcpTool,
} from "../../helpers/fake-mcp-server.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { serverSyncBody } from "../../../../web/src/lib/integration-server-sync.ts";
import type { IntegrationAuthStatus } from "@appstrate/shared-types";

/** A 1×1 PNG header: what `isIconImage` reads (signature + `IHDR` size). */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0,
]);
const ICON = `data:image/png;base64,${PNG.toBase64()}`;
/** Listed first: an SVG is never taken, whatever its declared type. */
const SVG = `data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'/>")}`;
const TOKEN = "tok-live-123";
const ID = "@acme/docs";
/** Annotated read-only, explicitly not, and not at all: only the first two are pre-selected. */
const TOOLS: FakeMcpTool[] = [
  {
    name: "search",
    title: "Search documents",
    description: "Full-text search.",
    annotations: { readOnlyHint: true },
  },
  { name: "fetch", annotations: { readOnlyHint: true } },
  { name: "create", description: "Create a document.", annotations: { readOnlyHint: false } },
  "update",
  { name: "delete", annotations: { destructiveHint: true } },
];
const TOOL_NAMES = ["search", "fetch", "create", "update", "delete"];
const READ_ONLY = ["search", "fetch"];

let server: FakeMcpServer;
let restoreEgress: () => void;

beforeAll(() => {
  restoreEgress = allowLoopbackOAuthEgress();
  server = startFakeMcpServer({
    tools: TOOLS,
    pageSize: 2,
    bearer: TOKEN,
    serverInfo: {
      name: "acme-docs-mcp",
      title: "Acme Docs",
      version: "2.0.0",
      description: "Search and edit Acme documents.",
      websiteUrl: "https://acme.example/",
      icons: [{ src: SVG, mimeType: "image/svg+xml" }, { src: ICON }],
    },
    instructions: "Call search before fetch.",
  });
});

afterAll(() => {
  server.stop();
  restoreEgress();
});

const remote = (opts: { url?: string; transport?: string; authorizedUris?: string[] } = {}) =>
  remoteIntegrationManifest({
    name: ID,
    url: opts.url ?? server.url,
    ...(opts.transport ? { transport: opts.transport } : {}),
    auths: {
      api_key: {
        type: "api_key",
        authorizedUris: opts.authorizedUris ?? [`${server.origin}/**`],
        credentialFields: ["token"],
        requiredCredentialFields: ["token"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.token}",
          },
        },
      },
    },
  });

const sync = (ctx: TestContext, body?: unknown) =>
  getTestApp().request(`/api/integrations/${ID}/discover`, {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("POST /api/integrations/{packageId}/discover", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "acme" });
    server.authorizations.length = 0;
    server.methods.length = 0;
    // Each sync probes the era: the counts below include it.
    forgetProtocolEras();
  });

  it("lists every tool through the proxy, with the connection's bearer, pre-selecting the read-only ones", async () => {
    await seedProxyIntegration(ctx, remote());
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

    const res = await sync(ctx, { connection_id: connectionId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      manifest: {
        default_tools: READ_ONLY,
        tools_policy: Object.fromEntries(TOOL_NAMES.map((name) => [name, {}])),
        display_name: "Acme Docs",
        description: "Search and edit Acme documents.",
        homepage: "https://acme.example/",
        icon: ICON,
      },
      icon_source: ICON,
      instructions: "Call search before fetch.",
      tools: [
        {
          name: "search",
          title: "Search documents",
          description: "Full-text search.",
          read_only: true,
          destructive: false,
        },
        { name: "fetch", read_only: true, destructive: false },
        {
          name: "create",
          description: "Create a document.",
          read_only: false,
          destructive: false,
        },
        { name: "update", description: "Tool update", read_only: false, destructive: false },
        { name: "delete", read_only: false, destructive: true },
      ],
      warnings: [],
    });
    // The era probe (refused: a legacy server), initialize + initialized + three tools/list
    // pages, each carrying the injected credential; the standalone GET stream is never opened.
    expect(server.methods).toEqual(["POST", "POST", "POST", "POST", "POST", "POST"]);
    expect(server.authorizations.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("proposes no instructions when the draft already holds an INTEGRATION.md", async () => {
    const manifest = remote();
    await seedProxyIntegration(ctx, manifest);
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    // Whatever the file says: markdown, a JSON-shaped text, nothing at all.
    for (const doc of ["# Docs\n", '{"instructions":"Do not mutate"}', ""]) {
      await uploadPackageFiles("integrations", ctx.orgId, ID, {
        "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
        "INTEGRATION.md": new TextEncoder().encode(doc),
      });
      const res = await sync(ctx, {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as { instructions: string | null; warnings: unknown[] };
      expect(body.instructions).toBeNull();
      expect(body.warnings).toEqual([]);
    }
    // The stored tree without the file: the server's instructions are proposed again.
    await uploadPackageFiles("integrations", ctx.orgId, ID, {
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    });
    const res = await sync(ctx, {});
    expect(((await res.json()) as { instructions: string | null }).instructions).toBe(
      "Call search before fetch.",
    );
  });

  it("journals each MCP exchange as a proxied call of the connection", async () => {
    await seedProxyIntegration(ctx, remote());
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    expect((await sync(ctx, { connection_id: connectionId })).status).toBe(200);
    await drainAudits(5_000);
    // This connection's rows only: a previous test's journal writes are asynchronous and can land
    // after the truncate. Inserts are fire-and-forget, so their order is not the exchange order.
    const rows = await db
      .select()
      .from(connectionCalls)
      .where(eq(connectionCalls.connectionId, connectionId));
    // The era probe (400), initialize, the `initialized` notification (202), three pages.
    expect(rows.map((row) => row.outcome).sort()).toEqual([
      "200",
      "200",
      "200",
      "200",
      "202",
      "400",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        connectionId,
        integrationId: ID,
        spaceId: ctx.defaultSpaceId,
        actorId: ctx.user.id,
        authMethod: "session",
        runId: null,
        method: "POST",
        host: new URL(server.origin).hostname,
      });
    }
  });

  it("refuses a connection of another member named by a call-own caller", async () => {
    await seedProxyIntegration(ctx, remote());
    const ownerConnection = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    const member = await memberHolding(ctx, [
      "integrations:read",
      "integrations:write",
      "credential-proxy:call-own",
    ]);
    const res = await sync(member, { connection_id: ownerConnection });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("integration_not_connected");
    expect(server.methods).toEqual([]);
  });

  it("selects the caller's connection when none is named (empty body)", async () => {
    await seedProxyIntegration(ctx, remote());
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    const res = await sync(ctx);
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { manifest: { default_tools: string[] } }).manifest.default_tools,
    ).toEqual(READ_ONLY);
  });

  it("syncs with the imposed org connection instead of the caller's only own account", async () => {
    await seedProxyIntegration(ctx, remote());
    const imposed = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN }, "org");
    const caller = await memberHolding(ctx, [
      "integrations:read",
      "integrations:write",
      "credential-proxy:call",
    ]);
    const own = await seedProxyConnection(caller, ID, "api_key", { token: "own-token" }, "own");
    await db.insert(integrationConnectionShares).values({
      connectionId: imposed,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
    });
    await db.insert(integrationOrgDefaults).values({
      spaceId: ctx.defaultSpaceId,
      integrationId: ID,
      connectionIds: [imposed],
      enforce: true,
    });
    const listed = await getTestApp().request(`/api/integrations/${ID}`, {
      headers: authHeaders(caller),
    });
    expect(listed.status).toBe(200);
    const detail = (await listed.json()) as { auths: IntegrationAuthStatus[] };
    expect(detail.auths.flatMap((auth) => auth.connections.map((c) => c.id))).toContain(own);

    const res = await sync(caller, serverSyncBody());
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { manifest: { default_tools: string[] } }).manifest.default_tools,
    ).toEqual(READ_ONLY);
    expect(server.authorizations.every((value) => value === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("asks for connection_id when the caller holds several usable connections", async () => {
    await seedProxyIntegration(ctx, remote());
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN }, "acct-1");
    const second = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN }, "acct-2");

    const res = await sync(ctx, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      detail: string;
      errors: { message: string; candidate_connections: { id: string }[] }[];
    };
    expect(body.code).toBe("must_choose_connection");
    expect(body.detail).toContain("connection_id");
    expect(body.detail).not.toContain("X-Connection-Id");
    expect(body.errors[0]!.message).toBe(body.detail);
    expect(body.errors[0]!.candidate_connections.map((c) => c.id)).toContain(second);
    expect(server.methods).toEqual([]);

    expect((await sync(ctx, { connection_id: second })).status).toBe(200);
  });

  it("answers 409 integration_not_connected without a connection", async () => {
    await seedProxyIntegration(ctx, remote());
    const res = await sync(ctx, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("integration_not_connected");
    expect(server.methods).toEqual([]);
  });

  it("syncs a draft never published, through the draft's auth, journaling each exchange", async () => {
    await seedPackage({
      id: ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: remote(),
    });
    await db
      .insert(spacePackages)
      .values({ enabled: true, spaceId: ctx.defaultSpaceId, packageId: ID });
    const connectionId = await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });

    const res = await sync(ctx, { connection_id: connectionId });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { manifest: { default_tools: string[] } }).manifest.default_tools,
    ).toEqual(READ_ONLY);
    expect(server.authorizations.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    await drainAudits(5_000);
    const rows = await db
      .select()
      .from(connectionCalls)
      .where(eq(connectionCalls.connectionId, connectionId));
    // The era probe, initialize, initialized, three pages.
    expect(rows).toHaveLength(6);
  });

  it("authorizes against the draft, not the published version", async () => {
    // Published: the server's origin authorized. Draft: another host only.
    await seedProxyIntegration(ctx, remote());
    await db
      .update(packages)
      .set({ draftManifest: remote({ authorizedUris: ["https://api.example.com/**"] }) })
      .where(eq(packages.id, ID));
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    const res = await sync(ctx, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized_target");
    expect(server.methods).toEqual([]);
  });

  it("reads the draft's source: a draft no longer remote is refused", async () => {
    await seedProxyIntegration(ctx, remote());
    await db
      .update(packages)
      .set({
        draftManifest: localIntegrationManifest({
          name: ID,
          auths: { api_key: { type: "api_key" } },
        }),
      })
      .where(eq(packages.id, ID));
    const res = await sync(ctx, {});
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("integration_not_remote");
  });

  it("answers 404 for a draft not active in the space", async () => {
    await seedPackage({
      id: ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: remote(),
    });
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    const res = await sync(ctx, {});
    expect(res.status).toBe(404);
    expect(server.methods).toEqual([]);
  });

  it("is refused without write authority on the package", async () => {
    await seedProxyIntegration(ctx, remote());
    const member = await memberHolding(ctx, [
      "integrations:read",
      "integrations:connect",
      "credential-proxy:call-own",
    ]);
    await seedProxyConnection(member, ID, "api_key", { token: TOKEN });
    const res = await sync(member, {});
    expect(res.status).toBe(403);
    expect(server.methods).toEqual([]);
  });

  it("is refused without credential-proxy:call-own", async () => {
    await seedProxyIntegration(ctx, remote());
    const member = await memberHolding(ctx, ["integrations:read", "integrations:write"]);
    const res = await sync(member, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: string }).detail).toContain(
      "credential-proxy:call-own",
    );
    expect(server.methods).toEqual([]);
  });

  it("enforces the auth's authorized_uris: a server URL outside it is never reached", async () => {
    await seedProxyIntegration(ctx, remote({ authorizedUris: ["https://api.example.com/**"] }));
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    const res = await sync(ctx, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized_target");
    expect(server.methods).toEqual([]);
  });

  it("answers 422 for an SSE server", async () => {
    await seedProxyIntegration(ctx, remote({ transport: "sse" }));
    await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
    const res = await sync(ctx, {});
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("sync_transport_unsupported");
  });

  it("answers 422 for a server URL chosen per connection", async () => {
    await seedProxyIntegration(ctx, {
      ...remote(),
      schema_version: "0.3",
      source: {
        kind: "remote",
        remote: { url: "{$variable.base_url}/mcp", transport: "streamable-http" },
      },
      variables: {
        schema: {
          type: "object",
          properties: { base_url: { type: "string", format: "uri" } },
          required: ["base_url"],
        },
      },
    } as unknown as IntegrationManifest);
    const res = await sync(ctx, {});
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("sync_url_templated");
  });

  it("answers 422 for an integration that is not remote", async () => {
    await seedProxyIntegration(
      ctx,
      localIntegrationManifest({ name: ID, auths: { api_key: { type: "api_key" } } }),
    );
    const res = await sync(ctx, {});
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("integration_not_remote");
  });

  it("answers 502 when the server refuses the credential", async () => {
    await seedProxyIntegration(ctx, remote());
    await seedProxyConnection(ctx, ID, "api_key", { token: "wrong" });
    const res = await sync(ctx, {});
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe("bad_gateway");
    expect(body.detail).toContain("refused the connection's credential");
  });

  it("sends the server's own header values back as written: no placeholder reaches a credential", async () => {
    const hostile = startFakeMcpServer({
      tools: TOOLS,
      pageSize: 2,
      bearer: TOKEN,
      sessionId: "{{token}}",
    });
    try {
      await seedProxyIntegration(
        ctx,
        remote({ url: hostile.url, authorizedUris: [`${hostile.origin}/**`] }),
      );
      await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
      const res = await sync(ctx, {});
      expect(res.status).toBe(200);
      // Past the era probe and `initialize`, every MCP exchange (the icon lookup's GETs carry no body).
      const echoed = hostile.requests.slice(2).filter(({ body }) => body !== "");
      expect(echoed).toHaveLength(4);
      for (const { headers } of echoed) {
        expect(headers.get("mcp-session-id")).toBe("{{token}}");
        const sent = [...headers].filter(([name]) => name !== "authorization");
        expect(JSON.stringify(sent)).not.toContain(TOKEN);
      }
    } finally {
      hostile.stop();
    }
  });

  for (const era of ["modern", "dual"] as const) {
    it(`synchronizes a ${era === "modern" ? "modern-only" : "dual-era"} server statelessly`, async () => {
      const upstream = startFakeMcpServer({
        era,
        tools: TOOLS,
        pageSize: 2,
        bearer: TOKEN,
        serverInfo: { name: "acme-docs-mcp", title: "Acme Docs", version: "3.0.0" },
        instructions: "Call search before fetch.",
      });
      try {
        await seedProxyIntegration(
          ctx,
          remote({ url: upstream.url, authorizedUris: [`${upstream.origin}/**`] }),
        );
        await seedProxyConnection(ctx, ID, "api_key", { token: TOKEN });
        const res = await sync(ctx, {});
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          manifest: Record<string, unknown>;
          instructions: string | null;
        };
        expect(body.manifest.default_tools).toEqual(READ_ONLY);
        expect(body.manifest.display_name).toBe("Acme Docs");
        expect(body.instructions).toBe("Call search before fetch.");
        const posted = upstream.requests
          .filter(({ body: text }) => text !== "")
          .map(({ headers, body: text }) => ({
            method: (JSON.parse(text) as { method: string }).method,
            version: headers.get("mcp-protocol-version"),
          }));
        // `server/discover`, then three pages: no `initialize`, no session, the credential on each.
        expect(posted).toEqual([
          { method: "server/discover", version: "2026-07-28" },
          { method: "tools/list", version: "2026-07-28" },
          { method: "tools/list", version: "2026-07-28" },
          { method: "tools/list", version: "2026-07-28" },
        ]);
        expect(upstream.authorizations.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
      } finally {
        upstream.stop();
      }
    });
  }

  it("refuses an unknown body field", async () => {
    await seedProxyIntegration(ctx, remote());
    expect((await sync(ctx, { url: server.url })).status).toBe(400);
  });
});

describe("POST /api/integrations/{packageId}/discover — unauthenticated integration (AFPS §7.2)", () => {
  const OPEN_ID = "@acme/open";
  let ctx: TestContext;
  let open: FakeMcpServer;
  let restore: () => void;

  beforeAll(() => {
    restore = allowLoopbackOAuthEgress();
    open = startFakeMcpServer({ tools: TOOLS, pageSize: 2 });
  });

  afterAll(() => {
    open.stop();
    restore();
  });

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "acme" });
    open.authorizations.length = 0;
    forgetProtocolEras();
  });

  const unauthenticated = (url: string) =>
    ({
      type: "integration",
      schema_version: "0.3",
      name: OPEN_ID,
      version: "1.0.0",
      display_name: "Open",
      source: { kind: "remote", remote: { url, transport: "streamable-http" } },
    }) as unknown as IntegrationManifest;

  const syncOpen = (caller: TestContext = ctx) =>
    getTestApp().request(`/api/integrations/${OPEN_ID}/discover`, {
      method: "POST",
      headers: { ...authHeaders(caller), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

  it("asks write authority on the package, not a credential-proxy right", async () => {
    await seedProxyIntegration(ctx, unauthenticated(open.url));
    const member = await memberHolding(ctx, ["integrations:read", "integrations:write"]);
    const res = await syncOpen(member);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { name: string }[] };
    expect(body.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
  });

  it("lists the server's tools with no connection and no credential", async () => {
    await seedProxyIntegration(ctx, unauthenticated(open.url));
    const res = await syncOpen();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { name: string }[] };
    expect(body.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(open.authorizations.length).toBeGreaterThan(0);
    expect(open.authorizations.every((a) => a === null)).toBe(true);
  });

  it("answers 502 when the server asks for a credential: never authorized ad hoc", async () => {
    const guarded = startFakeMcpServer({ tools: TOOLS, bearer: "nope" });
    try {
      await seedProxyIntegration(ctx, unauthenticated(guarded.url));
      const res = await syncOpen();
      expect(res.status).toBe(502);
      expect(((await res.json()) as { detail: string }).detail).toContain(
        "declares no authentication",
      );
      expect(guarded.authorizations.every((a) => a === null)).toBe(true);
    } finally {
      guarded.stop();
    }
  });
});
