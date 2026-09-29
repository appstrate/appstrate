// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the credential-proxy cookie jar (issue #1613).
 *
 * Successive `proxyCall()` invocations sharing one session id replay the
 * cookies upstreams set: merged with an injected `Cookie` credential (the
 * upstream's value wins by name, a deletion falls back to the credential),
 * stripped of attributes, accumulated across calls, and scoped by origin
 * exactly like the in-container sidecar.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageShare } from "../../helpers/seed.ts";
import { spacePackages, integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { proxyCall } from "../../../src/services/credential-proxy/core.ts";
import { LocalCookieJarStore } from "../../../src/infra/cookie-jar/local-cookie-jar.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const SESSION_ID = "session-1613";
const BEARER = httpHeaderDelivery({ name: "Authorization", prefix: "Bearer ", field: "api_key" });

async function seedConnectedIntegration(
  ctx: TestContext,
  opts: {
    packageId: string;
    authorizedUris: string[];
    delivery: ReturnType<typeof httpHeaderDelivery>;
    apiKey: string;
  },
): Promise<void> {
  await seedPackage({
    id: opts.packageId,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: localIntegrationManifest({
      name: opts.packageId,
      displayName: "Shop",
      description: "Shop integration",
      auths: {
        api: {
          type: "api_key",
          authorizedUris: opts.authorizedUris,
          delivery: opts.delivery,
        },
      },
    }),
  });
  await seedPackageShare(ctx.defaultSpaceId, opts.packageId);
  await db.insert(spacePackages).values({
    spaceId: ctx.defaultSpaceId,
    packageId: opts.packageId,
  });
  await db.insert(integrationConnections).values({
    integrationId: opts.packageId,
    authKey: "api",
    accountId: "acct-1",
    spaceId: ctx.defaultSpaceId,
    userId: ctx.user.id,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: opts.apiKey } }),
    scopesGranted: [],
    sharedWithOrg: false,
  });
}

/**
 * Scripted upstream: the n-th call answers with the n-th `Set-Cookie` list
 * (none past the end) and records the headers it received.
 */
function scriptedUpstream(setCookies: string[][]) {
  const seen: Headers[] = [];
  const fetchImpl = ((_url: string, init: RequestInit) => {
    const received = new Headers(init.headers);
    const responseHeaders = new Headers();
    for (const c of setCookies[seen.length] ?? []) responseHeaders.append("Set-Cookie", c);
    seen.push(received);
    return Promise.resolve(new Response("{}", { status: 200, headers: responseHeaders }));
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** The `Cookie` header as a sorted list of `name=value` pairs. */
function cookiePairs(headers: Headers | undefined): string[] {
  const raw = headers?.get("cookie");
  return raw
    ? raw
        .split(";")
        .map((p) => p.trim())
        .sort()
    : [];
}

describe("proxyCall — session cookie jar (#1613)", () => {
  let ctx: TestContext;
  let jar: LocalCookieJarStore;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "cpcookieorg" });
    jar = new LocalCookieJarStore();
  });

  const call = (packageId: string, target: string, fetchImpl: typeof fetch) =>
    proxyCall({
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: packageId,
      method: "POST",
      target,
      headers: {},
      body: "order_id=0",
      cookieJar: jar,
      jarSessionId: SESSION_ID,
      cookieJarTtlSeconds: 600,
      fetch: fetchImpl,
    });

  const cookieCredential = (packageId: string) =>
    seedConnectedIntegration(ctx, {
      packageId,
      authorizedUris: ["https://1.1.1.1/**"],
      delivery: httpHeaderDelivery({ name: "Cookie", prefix: "PHPSESSID=", field: "api_key" }),
      apiKey: "sess-abc",
    });

  it("keeps the injected session cookie alongside upstream cookies (reproduction)", async () => {
    const packageId = "@cpcookieorg/shop";
    await cookieCredential(packageId);
    const upstream = scriptedUpstream([["pref=1; Path=/; HttpOnly"]]);

    const first = await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    const second = await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(cookiePairs(upstream.seen[0])).toEqual(["PHPSESSID=sess-abc"]);
    expect(cookiePairs(upstream.seen[1])).toEqual(["PHPSESSID=sess-abc", "pref=1"]);
  });

  it("replays an upstream-rotated session instead of the injected one", async () => {
    const packageId = "@cpcookieorg/shop";
    await cookieCredential(packageId);
    const upstream = scriptedUpstream([["PHPSESSID=rotated; Path=/"]]);

    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);

    expect(cookiePairs(upstream.seen[1])).toEqual(["PHPSESSID=rotated"]);
  });

  it("falls back to the injected session once the upstream deletes its cookie", async () => {
    const packageId = "@cpcookieorg/shop";
    await cookieCredential(packageId);
    const upstream = scriptedUpstream([["PHPSESSID=rotated"], ["PHPSESSID=; Max-Age=0"]]);

    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);

    expect(cookiePairs(upstream.seen[1])).toEqual(["PHPSESSID=rotated"]);
    expect(cookiePairs(upstream.seen[2])).toEqual(["PHPSESSID=sess-abc"]);
  });

  it("accumulates cookies across responses", async () => {
    const packageId = "@cpcookieorg/shop";
    await cookieCredential(packageId);
    const upstream = scriptedUpstream([["a=1"], ["b=2"]]);

    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);

    expect(cookiePairs(upstream.seen[2])).toEqual(["PHPSESSID=sess-abc", "a=1", "b=2"]);
  });

  describe("origin scoping", () => {
    it("does not replay a cookie to another host matched by a glob", async () => {
      const packageId = "@cpcookieorg/glob";
      await seedConnectedIntegration(ctx, {
        packageId,
        authorizedUris: ["https://*/**"],
        delivery: BEARER,
        apiKey: "tok",
      });
      const upstream = scriptedUpstream([["a=1"]]);

      await call(packageId, "https://1.1.1.1/x", upstream.fetchImpl);
      await call(packageId, "https://8.8.8.8/x", upstream.fetchImpl);
      await call(packageId, "https://1.1.1.1/x", upstream.fetchImpl);

      expect(upstream.seen[1]?.get("cookie")).toBeNull();
      expect(cookiePairs(upstream.seen[2])).toEqual(["a=1"]);
    });

    it("shares cookies between literally allowlisted hosts", async () => {
      const packageId = "@cpcookieorg/literal";
      await seedConnectedIntegration(ctx, {
        packageId,
        authorizedUris: ["https://1.1.1.1/**", "https://8.8.8.8/**"],
        delivery: BEARER,
        apiKey: "tok",
      });
      const upstream = scriptedUpstream([["a=1"]]);

      await call(packageId, "https://1.1.1.1/x", upstream.fetchImpl);
      await call(packageId, "https://8.8.8.8/x", upstream.fetchImpl);

      expect(cookiePairs(upstream.seen[1])).toEqual(["a=1"]);
    });
  });

  it("sends jar cookies without touching a non-cookie credential header", async () => {
    const packageId = "@cpcookieorg/bearer";
    await seedConnectedIntegration(ctx, {
      packageId,
      authorizedUris: ["https://1.1.1.1/**"],
      delivery: BEARER,
      apiKey: "tok",
    });
    const upstream = scriptedUpstream([["sid=abc; Path=/; Secure"]]);

    await call(packageId, "https://1.1.1.1/x", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/x", upstream.fetchImpl);

    expect(upstream.seen[1]?.get("authorization")).toBe("Bearer tok");
    expect(cookiePairs(upstream.seen[1])).toEqual(["sid=abc"]);
  });
});
