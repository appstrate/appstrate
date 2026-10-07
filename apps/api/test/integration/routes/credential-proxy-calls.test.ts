// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level tests for `POST /api/credential-proxy/calls` (multi-call envelope).
 *
 * The envelope adds no authorization path of its own: every call runs through
 * `proxyCall`, so these pin that the `/proxy` rules hold PER CALL and that one
 * refused call does not affect the others.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { seedApiKey, seedPackage, seedPublishedVersion } from "../../helpers/seed.ts";
import { spacePackages, integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const realFetch: typeof fetch = globalThis.fetch;
function mockUpstream(impl: FetchImpl): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}

const INTEGRATION_ID = "@cpcalls/gmail";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

interface CallResult {
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: string | null;
  body_encoding?: string;
  error?: { code: string; message: string };
}

describe("POST /api/credential-proxy/calls", () => {
  let ctx: TestContext;
  let apiKey: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "cpcalls" });
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: localIntegrationManifest({
        name: INTEGRATION_ID,
        displayName: "Gmail",
        description: "Gmail integration",
        auths: {
          api: {
            type: "api_key",
            authorizedUris: ["https://gmail.googleapis.com/**"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
            }),
          },
        },
      }),
    });
    await seedPublishedVersion(INTEGRATION_ID, "1.0.0");
    await db
      .insert(spacePackages)
      .values({ spaceId: ctx.defaultSpaceId, packageId: INTEGRATION_ID });
    await db.insert(integrationConnections).values({
      integrationId: INTEGRATION_ID,
      authKey: "api",
      accountId: "acct-1",
      label: "acct-1",
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "ya29.live-token" } }),
      scopesGranted: [],
      sharedWithOrg: false,
    });
    apiKey = (
      await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes: ["credential-proxy:call"],
      })
    ).rawKey;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function post(calls: unknown, extra: Record<string, string> = {}) {
    return app.request("/api/credential-proxy/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Org-Id": ctx.orgId,
        "X-Space-Id": ctx.defaultSpaceId,
        "X-Integration-Id": INTEGRATION_ID,
        "X-Session-Id": crypto.randomUUID(),
        "Content-Type": "application/json",
        ...extra,
      },
      body: JSON.stringify({ calls }),
    });
  }

  it("runs each call with the injected credential, in request order", async () => {
    const seen: Array<{ url: string; auth: string | null; body: string | null }> = [];
    mockUpstream(async (url, init) => {
      const u = String(url);
      seen.push({
        url: u,
        auth: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? init.body : null,
      });
      return new Response(JSON.stringify({ path: new URL(u).pathname }), {
        status: u.endsWith("/m2") ? 404 : 200,
        headers: { "content-type": "application/json", "set-cookie": "sid=secret" },
      });
    });

    const res = await post([
      { id: "a", method: "GET", target: `${GMAIL}/messages/m1` },
      { id: "b", method: "GET", target: `${GMAIL}/messages/m2` },
      { method: "POST", target: `${GMAIL}/messages/m3/modify`, body: '{"x":1}' },
    ]);

    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: CallResult[] };
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["a", 200],
      ["b", 404],
      ["2", 200],
    ]);
    expect(JSON.parse(results[0]!.body!)).toEqual({ path: "/gmail/v1/users/me/messages/m1" });
    // Set-Cookie is never relayed, as on /proxy.
    expect(results[0]!.headers?.["set-cookie"]).toBeUndefined();
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((s) => s.auth))).toEqual(new Set(["Bearer ya29.live-token"]));
    expect(seen.find((s) => s.url.endsWith("/modify"))!.body).toBe('{"x":1}');
  });

  it("refuses an off-allowlist call without sending it, and still runs the others", async () => {
    const urls: string[] = [];
    mockUpstream(async (url) => {
      urls.push(String(url));
      return new Response("{}", { status: 200 });
    });

    const res = await post([
      { id: "ok", method: "GET", target: `${GMAIL}/messages/m1` },
      { id: "evil", method: "GET", target: "https://evil.example.com/steal" },
      { id: "ok2", method: "GET", target: `${GMAIL}/messages/m2` },
    ]);

    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: CallResult[] };
    expect(results.map((r) => r.status)).toEqual([200, 403, 200]);
    expect(results[1]!.error?.code).toBe("unauthorized_target");
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => u.includes("evil"))).toBe(false);
  });

  it("never forwards a caller-supplied Authorization header", async () => {
    let auth: string | null = null;
    mockUpstream(async (_url, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response("{}", { status: 200 });
    });

    await post([
      {
        method: "GET",
        target: `${GMAIL}/profile`,
        headers: { Authorization: "Bearer attacker-token" },
      },
    ]);

    expect(auth as string | null).toBe("Bearer ya29.live-token");
  });

  it("returns a non-UTF-8 upstream body as base64", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    mockUpstream(async () => new Response(bytes, { status: 200 }));

    const res = await post([{ method: "GET", target: `${GMAIL}/blob` }]);
    const { results } = (await res.json()) as { results: CallResult[] };
    expect(results[0]!.body_encoding).toBe("base64");
    expect(Buffer.from(results[0]!.body!, "base64")).toEqual(Buffer.from(bytes));
  });

  it("rejects an envelope over max_calls, a body on GET and a duplicate id", async () => {
    mockUpstream(async () => new Response("should not be called", { status: 599 }));

    const tooMany = Array.from({ length: 51 }, () => ({
      method: "GET",
      target: `${GMAIL}/profile`,
    }));
    expect((await post(tooMany)).status).toBe(400);
    expect((await post([{ method: "GET", target: `${GMAIL}/profile`, body: "x" }])).status).toBe(
      400,
    );
    expect(
      (
        await post([
          { id: "x", method: "GET", target: `${GMAIL}/profile` },
          { id: "x", method: "GET", target: `${GMAIL}/profile` },
        ])
      ).status,
    ).toBe(400);
  });

  it("answers a connection failure once for the envelope, with nothing sent upstream", async () => {
    let upstream = 0;
    mockUpstream(async () => {
      upstream += 1;
      return new Response("{}", { status: 200 });
    });
    // No connection of this integration is reachable: /proxy answers 404, so does the envelope.
    await db.delete(integrationConnections);

    const res = await post([
      { method: "GET", target: `${GMAIL}/messages/m1` },
      { method: "GET", target: `${GMAIL}/messages/m2` },
    ]);

    expect(res.status).toBe(404);
    expect(upstream).toBe(0);
  });

  it("charges one rate-limit point per call, not one per envelope", async () => {
    mockUpstream(async () => new Response("{}", { status: 200 }));
    const fifty = Array.from({ length: 50 }, () => ({ method: "GET", target: `${GMAIL}/profile` }));

    // calls_per_min defaults to 600 = 12 full envelopes; the 13th is refused.
    for (let i = 0; i < 12; i++) expect((await post(fifty)).status).toBe(200);
    expect((await post(fifty)).status).toBe(429);
  });
});
