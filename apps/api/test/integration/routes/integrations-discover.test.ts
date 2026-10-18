// SPDX-License-Identifier: Apache-2.0
/**
 * `POST /api/integrations/discover` at the route boundary, against a real MCP-like
 * server on loopback reached through the operator's `EGRESS_ALLOW_INTERNAL_HOSTS`
 * opt-in: a 401 with an RFC 9728 challenge, its metadata, an RFC 8414 document
 * with a registration endpoint, and a favicon.
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
    };
    const iconSource = `data:image/png;base64,${PNG.toBase64()}`;
    expect(body).toEqual({
      manifest: {
        display_name: "Acme Tracker",
        name: "@acme/127-0-0-1",
        icon: iconSource,
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
      icon_source: iconSource,
      provenance: {
        "/display_name": "detected",
        "/name": "guessed",
        "/source/remote/transport": "guessed",
        "/auths/oauth": "detected",
        "/icon": "detected",
      },
      warnings: [],
    });
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

  it("answers 422 for a URL that is not an MCP server", async () => {
    const res = await discover(ctx, { url: `${origin}/nothing-here` });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("not_an_mcp_server");
  });
});
