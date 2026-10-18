// SPDX-License-Identifier: Apache-2.0
/**
 * An oauth2 auth acquired by refresh token at the route boundary: it connects through both fields
 * doors — the member route `connect/fields` and the hosted portal, whose dispatch hands it to the
 * form instead of an authorization server — and `connect/oauth2` refuses it.
 *
 * The token endpoint is a loopback server reached through `EGRESS_ALLOW_INTERNAL_HOSTS`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { getTestApp } from "../../helpers/app.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";
import { fieldsConnect, hostedSubmit } from "../../helpers/connect-surfaces.ts";
import { initSystemIntegrations } from "../../../src/services/integration-client-registry.ts";

const INTEGRATION_ID = "@myorg/mobile-sso";

let server: ReturnType<typeof Bun.serve>;
let restoreEgress: () => void;
let origin: string;
/** The `refresh_token` each exchange received. */
let exchanged: string[] = [];

beforeAll(() => {
  restoreEgress = allowLoopbackOAuthEgress();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/token") return new Response("no page", { status: 404 });
      const form = new URLSearchParams(await req.text());
      exchanged.push(form.get("refresh_token") ?? "");
      return Response.json({ access_token: "at", refresh_token: "rt-next", expires_in: 3600 });
    },
  });
  origin = `http://${server.hostname}:${server.port}`;
  initSystemIntegrations([
    {
      id: INTEGRATION_ID,
      clients: [
        {
          id: "mobile-sso-sys",
          auth_key: "account",
          client_id: "PUBLIC_MOBILE_CLIENT",
          token_endpoint_auth_method: "none",
        },
      ],
    },
  ]);
});

afterAll(() => {
  server.stop(true);
  restoreEgress();
  initSystemIntegrations([]);
});

describe("oauth2 acquired by refresh token — connect routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    exchanged = [];
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: {
        name: INTEGRATION_ID,
        version: "1.0.0",
        type: "integration",
        schema_version: "0.1",
        source: { kind: "none" },
        auths: {
          account: {
            type: "oauth2",
            authorization_endpoint: `${origin}/sign-in`,
            token_endpoint: `${origin}/token`,
            token_endpoint_auth_method: "none",
            authorized_uris: ["https://api.example.com/**"],
            credentials: {
              schema: {
                type: "object",
                properties: { refresh_token: { type: "string" } },
                required: ["refresh_token"],
              },
            },
            delivery: {
              http: {
                in: "header",
                name: "Authorization",
                prefix: "Bearer ",
                value: "{$credential.access_token}",
              },
            },
            _meta: {
              "dev.appstrate/oauth": {
                acquisition: "refresh_token",
                refresh_token_issuance: "default",
              },
            },
          },
        },
      },
    });
  });

  it.each([
    ["connect/fields", fieldsConnect],
    ["connect/submit", hostedSubmit],
  ] as const)("%s exchanges the submitted token and stores the connection", async (_, door) => {
    const res = await door(ctx, INTEGRATION_ID, "account", { refresh_token: "rt-submitted" });

    expect(res.status).toBe(200);
    expect(exchanged).toEqual(["rt-submitted"]);
  });

  it("connect/oauth2 refuses to start an authorization flow", async () => {
    const res = await getTestApp().request(
      `/api/integrations/${INTEGRATION_ID}/auths/account/connect/oauth2`,
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(400);
    expect(exchanged).toEqual([]);
  });
});
