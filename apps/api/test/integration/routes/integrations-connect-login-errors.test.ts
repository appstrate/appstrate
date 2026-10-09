// SPDX-License-Identifier: Apache-2.0
/**
 * A declarative `connect.login` at the route boundary, on both connect surfaces —
 * `POST /api/integrations/{packageId}/auths/{authKey}/connect/fields` (member) and
 * `POST /api/integrations/connect/submit` (hosted end-user form).
 *
 * The login target is a real HTTP server on loopback, reached through the operator's
 * `EGRESS_ALLOW_INTERNAL_HOSTS` opt-in: it accepts one username/password pair and
 * answers 401 otherwise, or fails with a 503 when told to.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { logger } from "../../../src/lib/logger.ts";
import { apiIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";

const app = getTestApp();

const INTEGRATION_ID = "@myorg/legacy-app";
const USERNAME = "alice";
// Every character a form body gives a meaning to.
const PASSWORD = "p&ss=w+rd %x";
const UPSTREAM_BODY = "upstream-says-no";

let server: ReturnType<typeof Bun.serve>;
let restoreEgress: () => void;
let failing = false;
/** Answer only after the login's `request_timeout_ms` has passed. */
let slow = false;
/** The `password` parameters of each login request the target received. */
let received: string[][] = [];
/** The parsed body of each JSON login request the target received. */
let receivedJson: unknown[] = [];

beforeAll(() => {
  restoreEgress = allowLoopbackOAuthEgress();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/json-login") {
        receivedJson.push(await req.json());
        return new Response("ok", { headers: { "Set-Cookie": "sid=session-1; Path=/" } });
      }
      if (new URL(req.url).pathname !== "/login") return new Response("no page", { status: 404 });
      const form = new URLSearchParams(await req.text());
      received.push(form.getAll("password"));
      if (slow) await Bun.sleep(1_000);
      if (failing) return new Response("maintenance", { status: 503 });
      if (form.get("username") === USERNAME && form.get("password") === PASSWORD) {
        return new Response("ok", { headers: { "Set-Cookie": "sid=session-1; Path=/" } });
      }
      return new Response(UPSTREAM_BODY, { status: 401 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  restoreEgress();
});

/** The login manifest; `mutate` edits its auth before it is seeded. */
function loginManifest(origin: string, mutate?: (auth: LoginAuth) => void) {
  const manifest = baseLoginManifest(origin);
  mutate?.((manifest as unknown as { auths: { session: LoginAuth } }).auths.session);
  return manifest;
}

interface LoginAuth {
  credentials: { schema: { properties: Record<string, unknown> } };
  connect: {
    login: { request: Record<string, unknown>; outputs: Record<string, unknown> };
    limits?: Record<string, number>;
  };
}

function baseLoginManifest(origin: string) {
  return apiIntegrationManifest({
    name: INTEGRATION_ID,
    auths: {
      session: {
        type: "custom",
        authorizedUris: [`${origin}/**`],
        credentialFields: ["username", "password"],
        connect: {
          login: {
            request: {
              method: "POST",
              url: `${origin}/login`,
              content_type: "application/x-www-form-urlencoded",
              body: "username={{username}}&password={{password}}",
            },
            success_criteria: [{ condition: "$statusCode == 200" }],
            outputs: { sid: { from: "cookie", name: "sid" } },
          },
        },
        delivery: { http: { in: "header", name: "Cookie", value: "sid={$credential.sid}" } },
      },
    },
  });
}

interface ProblemBody {
  status: number;
  code: string;
  detail: string;
  param?: string;
}

async function fieldsConnect(
  ctx: TestContext,
  credentials: Record<string, string>,
): Promise<Response> {
  return app.request(`/api/integrations/${INTEGRATION_ID}/auths/session/connect/fields`, {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify({ credentials }),
  });
}

/** Drive the hosted portal end to end: mint → dispatch → context → submit. */
async function hostedSubmit(
  ctx: TestContext,
  credentials: Record<string, string>,
): Promise<Response> {
  const mint = await app.request(
    `/api/integrations/${INTEGRATION_ID}/auths/session/connect/session`,
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
  const cookie = `appstrate_connect=${start.headers.get("set-cookie")!.match(/appstrate_connect=([^;]+)/)![1]}`;
  const context = (await (
    await app.request("/api/integrations/connect/context", { headers: { Cookie: cookie } })
  ).json()) as { csrf: string };
  return app.request("/api/integrations/connect/submit", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "x-connect-csrf": context.csrf },
    body: JSON.stringify({ credentials }),
  });
}

const surfaces = [
  ["connect/fields", fieldsConnect],
  ["connect/submit", hostedSubmit],
] as const;

describe("declarative connect.login at the route boundary", () => {
  let ctx: TestContext;

  /** Replace the integration with `manifest`, in a fresh organization. */
  async function reseed(manifest: ReturnType<typeof loginManifest>): Promise<void> {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
  }

  beforeEach(async () => {
    // The hosted flow is rate-limited per IP, and every test of the process shares one.
    await flushRedis();
    failing = false;
    slow = false;
    received = [];
    receivedJson = [];
    await reseed(loginManifest(server.url.origin));
  });

  for (const [surface, submit] of surfaces) {
    it(`${surface}: logs in with a password the form body would otherwise split`, async () => {
      const res = await submit(ctx, { username: USERNAME, password: PASSWORD });

      expect(res.status).toBe(200);
      expect(received).toEqual([[PASSWORD]]);
    });

    it(`${surface}: answers a refused login like a refused connect.tool login, echoing nothing`, async () => {
      const res = await submit(ctx, { username: USERNAME, password: "wrong&password" });

      expect(res.status).toBe(400);
      const raw = await res.text();
      const body = JSON.parse(raw) as ProblemBody;
      expect(body.code).toBe("invalid_request");
      expect(body.param).toBe("credentials");
      expect(body.detail).toStartWith("Login failed:");
      expect(body.detail).toContain("HTTP 401");
      expect(body.detail).toContain("Check the credentials you submitted");
      expect(raw).not.toContain("wrong&password");
      expect(raw).not.toContain(UPSTREAM_BODY);
    });

    it(`${surface}: answers a target slower than request_timeout_ms with 504 timeout`, async () => {
      slow = true;
      await reseed(
        loginManifest(server.url.origin, (auth) => {
          auth.connect.limits = { request_timeout_ms: 100 };
        }),
      );

      const res = await submit(ctx, { username: USERNAME, password: PASSWORD });

      expect(res.status).toBe(504);
      const raw = await res.text();
      const body = JSON.parse(raw) as ProblemBody;
      expect(body.code).toBe("timeout");
      expect(body.detail).toContain("after 100ms");
      expect(raw).not.toContain(PASSWORD);
    });

    it(`${surface}: types a JSON login's inputs by credentials.schema, not by what they spell`, async () => {
      await reseed(
        loginManifest(server.url.origin, (auth) => {
          auth.credentials.schema.properties = {
            pin: { type: "number" },
            code: { type: "string" },
          };
          auth.connect.login.request = {
            method: "POST",
            url: `${server.url.origin}/json-login`,
            content_type: "application/json",
            body: '{"pin":{{pin}},"code":{{code}}}',
          };
        }),
      );

      const res = await submit(ctx, { pin: "1234", code: "0123" });

      expect(res.status).toBe(200);
      expect(receivedJson).toEqual([{ pin: 1234, code: "0123" }]);
    });

    it(`${surface}: refuses credentials the schema refuses before any login request`, async () => {
      await reseed(
        loginManifest(server.url.origin, (auth) => {
          auth.credentials.schema.properties.password = { type: "string", minLength: 64 };
        }),
      );

      const res = await submit(ctx, { username: USERNAME, password: PASSWORD });

      expect(res.status).toBe(400);
      const raw = await res.text();
      expect((JSON.parse(raw) as ProblemBody).param).toBe("credentials");
      expect(raw).not.toContain(PASSWORD);
      expect(received).toEqual([]);
    });

    it(`${surface}: answers a failing target with 502 bad_gateway`, async () => {
      failing = true;

      const res = await submit(ctx, { username: USERNAME, password: PASSWORD });

      expect(res.status).toBe(502);
      const raw = await res.text();
      expect((JSON.parse(raw) as ProblemBody).code).toBe("bad_gateway");
      expect(raw).not.toContain(PASSWORD);
      expect(raw).not.toContain("maintenance");
    });

    it(`${surface}: refuses a base URL the submitter chose outside the allowlist, naming it`, async () => {
      await reseed(
        loginManifest(server.url.origin, (auth) => {
          auth.credentials.schema.properties.base_url = { type: "string" };
          auth.connect.login.request.url = "{{base_url}}/login";
        }),
      );

      // `localhost` passes the SSRF gate here (operator opt-in) but not `authorized_uris`,
      // which names 127.0.0.1; a loopback address the opt-in does not name fails the SSRF gate.
      for (const baseUrl of [`http://localhost:${server.port}`, "http://127.0.0.2:9"]) {
        const res = await submit(ctx, {
          base_url: baseUrl,
          username: USERNAME,
          password: PASSWORD,
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as ProblemBody;
        expect(body.code).toBe("invalid_request");
        expect(body.param).toBe("credentials.base_url");
      }
      expect(received).toEqual([]);
    });
  }

  it("connect/fields: answers an unreachable target with 502 bad_gateway", async () => {
    // A listener that drops every connection as it opens: the login request gets no answer.
    const dropper = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open: (socket) => socket.terminate(), data: () => {} },
    });
    await reseed(loginManifest(`http://127.0.0.1:${dropper.port}`));

    const warn = spyOn(logger, "warn");
    try {
      const res = await fieldsConnect(ctx, { username: USERNAME, password: PASSWORD });

      expect(res.status).toBe(502);
      expect(((await res.json()) as ProblemBody).code).toBe("bad_gateway");
      // The cause the 502 body leaves out reaches the operator's log, without the input.
      const logged = warn.mock.calls.find(([msg]) => msg === "connect.login did not complete");
      expect(logged?.[1]).toMatchObject({ reason: "upstream_failed" });
      expect(String((logged?.[1] as { error?: string }).error)).toStartWith("request failed:");
      expect(JSON.stringify(logged)).not.toContain(PASSWORD);
    } finally {
      warn.mockRestore();
      dropper.stop(true);
    }
  });

  it("connect/fields: refuses a value a header cannot carry with 400 naming the field", async () => {
    await reseed(
      loginManifest(server.url.origin, (auth) => {
        auth.connect.login.request.headers = { "X-User": "{{username}}" };
      }),
    );

    const res = await fieldsConnect(ctx, { username: "alice\r\nX-Admin: 1", password: PASSWORD });

    expect(res.status).toBe(400);
    const raw = await res.text();
    const body = JSON.parse(raw) as ProblemBody;
    expect(body.code).toBe("invalid_request");
    expect(body.param).toBe("credentials.username");
    expect(body.detail).toContain("cannot carry where it is placed");
    expect(raw).not.toContain("X-Admin");
    expect(received).toEqual([]);
  });

  it("connect/fields: keeps a login the integration cannot complete a generic 500", async () => {
    // The target never sets this cookie: a defect of the integration, not of the credentials.
    await reseed(
      loginManifest(server.url.origin, (auth) => {
        auth.connect.login.outputs = { sid: { from: "cookie", name: "absent" } };
      }),
    );

    const res = await fieldsConnect(ctx, { username: USERNAME, password: PASSWORD });

    expect(res.status).toBe(500);
    expect(((await res.json()) as ProblemBody).code).toBe("internal_error");
  });

  it("connect/fields: keeps an answer no criterion judges (a 404 without success_criteria) a 500", async () => {
    await reseed(
      loginManifest(server.url.origin, (auth) => {
        auth.connect.login.request.url = `${server.url.origin}/missing`;
        delete (auth.connect.login as Record<string, unknown>).success_criteria;
      }),
    );
    const res = await fieldsConnect(ctx, { username: USERNAME, password: "wrong" });

    // A wrong login URL, not wrong credentials.
    expect(res.status).toBe(500);
    expect(((await res.json()) as ProblemBody).code).toBe("internal_error");
  });
});
