// SPDX-License-Identifier: Apache-2.0
/**
 * An oauth2 auth acquiring its first token by `connect.login` (AFPS §7.7) at the route boundary: it
 * connects through both fields doors — the member route `connect/fields` and the hosted portal,
 * whose dispatch hands it to the form instead of an authorization server — and `connect/oauth2`
 * refuses it.
 *
 * The token endpoint is a loopback server reached through `EGRESS_ALLOW_INTERNAL_HOSTS`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { truncateAll, db } from "../../helpers/db.ts";
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
/** The `refresh_token` each token request carried. */
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
      return Response.json({
        access_token: "at",
        refresh_token: "rt-next",
        expires_in: 3600,
        user_id: "acct-42",
      });
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

describe("oauth2 acquired by connect.login — connect routes", () => {
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
            token_endpoint: `${origin}/token`,
            token_endpoint_auth_method: "none",
            identity_claims: { account_id: "$.user_id" },
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
            connect: {
              login: {
                request: {
                  method: "POST",
                  url: `${origin}/token`,
                  content_type: "application/x-www-form-urlencoded",
                  body: "grant_type=refresh_token&refresh_token={{refresh_token}}",
                },
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
  ] as const)("%s sends the rendered grant and stores the connection", async (_, door) => {
    const res = await door(ctx, INTEGRATION_ID, "account", { refresh_token: "rt-submitted" });

    expect(res.status).toBe(200);
    expect(exchanged).toEqual(["rt-submitted"]);
    const rows = await db
      .select({
        accountId: integrationConnections.accountId,
        clientRef: integrationConnections.clientRef,
      })
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION_ID));
    expect(rows).toEqual([{ accountId: "acct-42", clientRef: "mobile-sso-sys" }]);
  });

  it("the hosted dispatch hands the auth to the form, never to an authorization server", async () => {
    const app = getTestApp();
    const mint = await app.request(
      `/api/integrations/${INTEGRATION_ID}/auths/account/connect/session`,
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(mint.status).toBe(200);
    const token = new URL(
      ((await mint.json()) as { connect_url: string }).connect_url,
    ).searchParams.get("token")!;

    const start = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );

    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe("/connect");
    expect(start.headers.get("set-cookie")).toContain("appstrate_connect=");
    expect(exchanged).toEqual([]);
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
