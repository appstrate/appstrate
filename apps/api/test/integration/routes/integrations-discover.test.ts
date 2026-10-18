// SPDX-License-Identifier: Apache-2.0
/**
 * `POST /api/integrations/discover` at the route boundary, against a real MCP-like
 * server on loopback reached through the operator's `EGRESS_ALLOW_INTERNAL_HOSTS`
 * opt-in: a 401 with an RFC 9728 challenge, its metadata, an RFC 8414 document
 * with a registration endpoint, and a favicon — over plaintext, so never taken.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { flushRedis } from "../../helpers/redis.ts";
import {
  authHeaders,
  createTestContext,
  memberHolding,
  type TestContext,
} from "../../helpers/auth.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";
import { seedPackage, seedUnreachableSpace } from "../../helpers/seed.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { AFPS_SCHEMA_VERSION } from "@appstrate/core/validation";

/** A 1×1 PNG header: what `isIconImage` reads (signature + `IHDR` size). */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0,
]);

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let restoreEgress: () => void;

beforeAll(() => {
  restoreEgress = allowLoopbackOAuthEgress();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const json = (body: unknown) => Response.json(body);
      if (req.method === "POST" && pathname === "/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
          },
        });
      }
      if (pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["read", "write"],
          resource_name: "Acme Tracker",
        });
      }
      if (pathname === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
        });
      }
      if (pathname === "/favicon.ico") {
        return new Response(PNG, { headers: { "Content-Type": "image/png" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  restoreEgress();
});

/** A remote integration of `orgId` (null: the system's) at `url`, homed in `homeSpaceId` if given. */
const seedRemote = (
  id: string,
  url: string,
  orgId: string | null,
  opts: { displayName?: string; homeSpaceId?: string } = {},
) =>
  seedPackage({
    id,
    orgId,
    type: "integration",
    source: orgId === null ? "system" : "local",
    ...(opts.homeSpaceId ? { homeSpaceId: opts.homeSpaceId } : {}),
    draftManifest: remoteIntegrationManifest({
      name: id,
      url,
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
      auths: { api_key: { type: "api_key", authorizedUris: [`${new URL(url).origin}/**`] } },
    }),
  });

const discover = (ctx: TestContext, body: unknown) =>
  getTestApp().request("/api/integrations/discover", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/integrations/discover", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "acme" });
  });

  it("proposes a manifest from the server's metadata", async () => {
    const res = await discover(ctx, { url: `${origin}/mcp` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manifest: Record<string, unknown>;
      icon_source: string | null;
      provenance: Record<string, string>;
      warnings: unknown[];
      existing: unknown[];
    };
    expect(body).toEqual({
      manifest: {
        display_name: "Acme Tracker",
        name: "@acme/127-0-0-1",
        source: { kind: "remote", remote: { url: `${origin}/mcp`, transport: "streamable-http" } },
        auths: {
          oauth: {
            type: "oauth2",
            token_endpoint_auth_method: "none",
            default_scopes: ["read", "write"],
            scope_catalog: [
              { value: "read", label: "read" },
              { value: "write", label: "write" },
            ],
            authorized_uris: [`${origin}/**`],
            delivery: {
              http: {
                in: "header",
                name: "Authorization",
                prefix: "Bearer ",
                value: "{$credential.access_token}",
              },
            },
            _meta: {
              "dev.appstrate/oauth": { scope_separator: " " },
              "dev.appstrate/auth": { required: true },
            },
          },
        },
      },
      // A site's icon is read over https only.
      icon_source: null,
      provenance: {
        "/display_name": "detected",
        "/name": "guessed",
        "/source/remote/transport": "guessed",
        "/auths/oauth": "detected",
      },
      warnings: [],
      existing: [],
    });
  });

  it("names the integrations the caller already lists at the same URL, and only those", async () => {
    const url = `${origin}/mcp`;
    await seedRemote("@acme/tracker", url, ctx.orgId, { displayName: "Acme Tracker" });
    await seedRemote("@acme/other-path", `${origin}/other`, ctx.orgId);
    await seedRemote("@acme/trailing-slash", `${url}/`, ctx.orgId);
    // Homed in a space the caller does not reach, with nothing placing it here.
    await seedRemote("@acme/elsewhere", url, ctx.orgId, {
      homeSpaceId: await seedUnreachableSpace(ctx.orgId),
    });
    const stranger = await createTestContext({ orgSlug: "stranger" });
    await seedRemote("@stranger/tracker", url, stranger.orgId);
    await seedRemote("@appstrate/tracker", url, null);

    const res = await discover(ctx, { url });
    expect(res.status).toBe(200);
    const { existing } = (await res.json()) as { existing: unknown[] };
    expect(existing).toEqual([
      { integration_package_id: "@acme/tracker", display_name: "Acme Tracker" },
      { integration_package_id: "@appstrate/tracker", display_name: "@appstrate/tracker" },
    ]);
  });

  it("proposes a manifest every write-path validator accepts", async () => {
    const res = await discover(ctx, { url: `${origin}/mcp` });
    const { manifest } = (await res.json()) as { manifest: Record<string, unknown> };
    // What the editor saves: its blank manifest with the proposal merged in.
    const created = await getTestApp().request("/api/packages/integrations", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: {
          schema_version: AFPS_SCHEMA_VERSION,
          type: "integration",
          version: "1.0.0",
          description: "",
          ...manifest,
        },
      }),
    });
    expect(created.status).toBe(201);
  });

  it("is refused without integrations:write", async () => {
    const reader = await memberHolding(ctx, ["integrations:read"]);
    const res = await discover(reader, { url: `${origin}/mcp` });
    expect(res.status).toBe(403);
  });

  it("refuses a private or metadata address", async () => {
    for (const url of ["https://10.1.2.3/mcp", "http://169.254.169.254/latest/meta-data"]) {
      const res = await discover(ctx, { url });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { param?: string }).param).toBe("url");
    }
  });

  it("refuses a body that is not one URL", async () => {
    expect((await discover(ctx, { url: "not a url" })).status).toBe(400);
    expect((await discover(ctx, { url: `${origin}/mcp`, transport: "sse" })).status).toBe(400);
  });

  it("refuses a URL carrying a username or password", async () => {
    const at = new URL(`${origin}/mcp`);
    for (const userinfo of ["user@", "user:pass@", ":pass@"]) {
      const res = await discover(ctx, { url: `${at.protocol}//${userinfo}${at.host}/mcp` });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { field: string }[] };
      expect(body.errors?.map((e) => e.field)).toEqual(["url"]);
    }
  });

  it("answers 422 for a URL that is not an MCP server", async () => {
    const res = await discover(ctx, { url: `${origin}/nothing-here` });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("not_an_mcp_server");
  });
});
