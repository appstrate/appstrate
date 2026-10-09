// SPDX-License-Identifier: Apache-2.0
/**
 * A declarative `connect.login` whose request URL is a URL template (AFPS §7.7, §7.12): the login
 * goes to the host the connection's variable names, and its `authorized_uris` follow that host
 * (#1818). The target is a loopback login server reached through the operator's opt-in.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { apiIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";
import { fieldsConnect } from "../../helpers/connect-surfaces.ts";

const INTEGRATION_ID = "@myorg/self-hosted-app";

let server: ReturnType<typeof Bun.serve>;
let restoreEgress: () => void;
let received: string[] = [];

beforeAll(() => {
  restoreEgress = allowLoopbackOAuthEgress();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      received.push(new URL(req.url).pathname);
      return new Response("ok", { headers: { "Set-Cookie": "sid=session-1; Path=/" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
  restoreEgress();
});

function manifest() {
  return {
    ...apiIntegrationManifest({
      name: INTEGRATION_ID,
      auths: {
        session: {
          type: "custom",
          authorizedUris: ["{$variable.base_url}/**"],
          credentialFields: ["password"],
          connect: {
            login: {
              request: {
                method: "POST",
                url: "{$variable.base_url}/app/login",
                content_type: "application/x-www-form-urlencoded",
                body: "password={{password}}",
              },
              outputs: { sid: { from: "cookie", name: "sid" } },
            },
          },
          delivery: { http: { in: "header", name: "Cookie", value: "sid={$credential.sid}" } },
        },
      },
    }),
    variables: {
      schema: {
        type: "object",
        properties: { base_url: { type: "string", format: "uri" } },
        required: ["base_url"],
      },
    },
  };
}

describe("connect.login against the host a connection variable names", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await flushRedis();
    await truncateAll();
    received = [];
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest(),
    });
  });

  it("logs in at the rendered URL and stores the variable with the session", async () => {
    const res = await fieldsConnect(
      ctx,
      INTEGRATION_ID,
      "session",
      { password: "pw" },
      { base_url: server.url.origin },
    );

    expect(res.status).toBe(200);
    expect(received).toEqual(["/app/login"]);
    const id = ((await res.json()) as { id: string }).id;
    const [row] = await db
      .select({ variables: integrationConnections.variables })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    expect(row!.variables).toEqual({ base_url: server.url.origin });
  });

  it("refuses a login host the platform does not reach, before any request", async () => {
    const res = await fieldsConnect(
      ctx,
      INTEGRATION_ID,
      "session",
      { password: "pw" },
      { base_url: "http://10.0.0.1:9" },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: { field: string; code: string }[] };
    expect(body.errors?.[0]).toMatchObject({ field: "variables.base_url", code: "egress_blocked" });
    expect(received).toEqual([]);
  });
});
