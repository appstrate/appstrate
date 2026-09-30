// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the credential-proxy cookie jar (issue #1613).
 *
 * Successive `proxyCall()` invocations sharing one session id replay the
 * cookies upstreams set: merged with an injected `Cookie` credential (the
 * upstream's value wins by name, a deletion falls back to the credential),
 * stripped of attributes, accumulated across calls, scoped by origin exactly
 * like the in-container sidecar, and kept per connection.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { proxyCall } from "../../../src/services/credential-proxy/core.ts";
import { LocalCookieJarStore } from "../../../src/infra/cookie-jar/local-cookie-jar.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
  envDelivery,
} from "../../helpers/integration-manifests.ts";
import {
  seedProxyIntegration,
  seedProxyConnection,
} from "../../helpers/credential-proxy-fixtures.ts";

const SESSION_ID = "session-1613";
const BEARER = httpHeaderDelivery({ name: "Authorization", prefix: "Bearer ", field: "api_key" });
const SESSION_COOKIE = httpHeaderDelivery({
  name: "Cookie",
  prefix: "PHPSESSID=",
  field: "api_key",
});

/** Seed an api_key integration and one connection; returns the connection id. */
async function seedConnectedIntegration(
  ctx: TestContext,
  opts: {
    packageId: string;
    authorizedUris: string[];
    delivery: ReturnType<typeof httpHeaderDelivery>;
    apiKey: string;
  },
): Promise<string> {
  await seedProxyIntegration(
    ctx,
    localIntegrationManifest({
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
  );
  return seedProxyConnection(ctx, opts.packageId, "api", { api_key: opts.apiKey });
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

/** Upstream answering `respond(url, n)` for the n-th request (1-based), redirect hops included. */
function recordingUpstream(respond: (url: string, n: number) => Response) {
  const seen: Array<{ request: string; cookie: string | null }> = [];
  const fetchImpl = ((url: string | URL, init: RequestInit) => {
    seen.push({
      request: `${init.method} ${url}`,
      cookie: new Headers(init.headers).get("cookie"),
    });
    return Promise.resolve(respond(url.toString(), seen.length));
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const redirect = (location: string, setCookie: string) =>
  new Response(null, { status: 302, headers: { location, "Set-Cookie": setCookie } });

/** A `Cookie` header as a sorted list of `name=value` pairs. */
function cookiePairs(cookie: string | null | undefined): string[] {
  return cookie
    ? cookie
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

  const call = (
    packageId: string,
    target: string,
    fetchImpl: typeof fetch,
    connectionId?: string,
  ) =>
    proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      ...(connectionId ? { connectionId } : {}),
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

  const cookieCredential = (packageId: string, authorizedUris = ["https://1.1.1.1/**"]) =>
    seedConnectedIntegration(ctx, {
      packageId,
      authorizedUris,
      delivery: SESSION_COOKIE,
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
    expect(cookiePairs(upstream.seen[0]?.get("cookie"))).toEqual(["PHPSESSID=sess-abc"]);
    expect(cookiePairs(upstream.seen[1]?.get("cookie"))).toEqual(["PHPSESSID=sess-abc", "pref=1"]);
  });

  it("replays an upstream-rotated session instead of the injected one", async () => {
    const packageId = "@cpcookieorg/shop";
    await cookieCredential(packageId);
    const upstream = scriptedUpstream([["PHPSESSID=rotated; Path=/"]]);

    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);

    expect(cookiePairs(upstream.seen[1]?.get("cookie"))).toEqual(["PHPSESSID=rotated"]);
  });

  it("falls back to the injected session once the upstream deletes its cookie", async () => {
    const packageId = "@cpcookieorg/shop";
    await cookieCredential(packageId);
    const upstream = scriptedUpstream([["PHPSESSID=rotated"], ["PHPSESSID=; Max-Age=0"]]);

    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);

    expect(cookiePairs(upstream.seen[1]?.get("cookie"))).toEqual(["PHPSESSID=rotated"]);
    expect(cookiePairs(upstream.seen[2]?.get("cookie"))).toEqual(["PHPSESSID=sess-abc"]);
  });

  it("accumulates cookies across responses", async () => {
    const packageId = "@cpcookieorg/shop";
    await cookieCredential(packageId);
    const upstream = scriptedUpstream([["a=1"], ["b=2"]]);

    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);

    expect(cookiePairs(upstream.seen[2]?.get("cookie"))).toEqual([
      "PHPSESSID=sess-abc",
      "a=1",
      "b=2",
    ]);
  });

  it("does not let a slow concurrent call resurrect a deleted session", async () => {
    const packageId = "@cpcookieorg/shop";
    await cookieCredential(packageId);
    const sent: string[] = [];
    let slowReached!: () => void;
    const reached = new Promise<void>((r) => (slowReached = r));
    let releaseSlow!: () => void;
    const released = new Promise<void>((r) => (releaseSlow = r));
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const n = sent.push(new Headers(init.headers).get("cookie") ?? "");
      const headers = new Headers();
      if (n === 1) headers.append("Set-Cookie", "PHPSESSID=rotated");
      if (n === 2) {
        slowReached();
        await released;
        headers.append("Set-Cookie", "pref=1");
      }
      if (n === 3) headers.append("Set-Cookie", "PHPSESSID=; Max-Age=0");
      return new Response("{}", { status: 200, headers });
    }) as unknown as typeof fetch;

    await call(packageId, "https://1.1.1.1/cart", fetchImpl); // rotates
    const slow = call(packageId, "https://1.1.1.1/cart", fetchImpl); // read {rotated}, stalls
    await reached;
    await call(packageId, "https://1.1.1.1/cart", fetchImpl); // deletes
    releaseSlow();
    await slow;
    await call(packageId, "https://1.1.1.1/cart", fetchImpl);

    expect(cookiePairs(sent[3])).toEqual(["PHPSESSID=sess-abc", "pref=1"]);
  });

  it("keeps one jar per connection on a shared session id", async () => {
    const packageId = "@cpcookieorg/shop";
    const connectionA = await cookieCredential(packageId);
    const connectionB = await seedProxyConnection(
      ctx,
      packageId,
      "api",
      { api_key: "sess-b" },
      "acct-2",
    );
    const upstream = scriptedUpstream([["PHPSESSID=rotated-a"]]);

    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl, connectionA);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl, connectionB);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl, connectionA);

    expect(cookiePairs(upstream.seen[1]?.get("cookie"))).toEqual(["PHPSESSID=sess-b"]);
    expect(cookiePairs(upstream.seen[2]?.get("cookie"))).toEqual(["PHPSESSID=rotated-a"]);
  });

  it("files each redirect hop's cookies under that hop's origin", async () => {
    const packageId = "@cpcookieorg/open";
    await cookieCredential(packageId, ["https://1.1.1.1/**", "https://8.8.8.8/**"]);
    const upstream = recordingUpstream((_url, n) =>
      n === 1
        ? new Response(null, { status: 302, headers: { location: "https://8.8.8.8/landing" } })
        : new Response("{}", { status: 200, headers: { "Set-Cookie": "PHPSESSID=planted" } }),
    );

    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://8.8.8.8/landing", upstream.fetchImpl);

    expect(upstream.seen.map((s) => s.request)).toEqual([
      "POST https://1.1.1.1/cart",
      "GET https://8.8.8.8/landing",
      "POST https://1.1.1.1/cart",
      "POST https://8.8.8.8/landing",
    ]);
    // An origin the allowlist names keeps the credential cookie, as on the sidecar (#1641).
    expect(cookiePairs(upstream.seen[1]?.cookie)).toEqual(["PHPSESSID=sess-abc"]);
    expect(cookiePairs(upstream.seen[2]?.cookie)).toEqual(["PHPSESSID=sess-abc"]);
    expect(cookiePairs(upstream.seen[3]?.cookie)).toEqual(["PHPSESSID=planted"]);
  });

  it("sends a session rotated on a redirect to the next hop and the next call", async () => {
    const packageId = "@cpcookieorg/shop";
    await cookieCredential(packageId);
    const upstream = recordingUpstream((url) =>
      url.endsWith("/cart/add")
        ? redirect("/cart", "PHPSESSID=new; Path=/; HttpOnly")
        : new Response("{}", { status: 200 }),
    );

    await call(packageId, "https://1.1.1.1/cart/add", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);

    expect(upstream.seen.map((s) => s.request)).toEqual([
      "POST https://1.1.1.1/cart/add",
      "GET https://1.1.1.1/cart",
      "POST https://1.1.1.1/cart",
    ]);
    expect(upstream.seen.map((s) => s.cookie)).toEqual([
      "PHPSESSID=sess-abc",
      "PHPSESSID=new",
      "PHPSESSID=new",
    ]);
  });

  it("keeps a redirect hop's session when the next hop is refused", async () => {
    const packageId = "@cpcookieorg/shop";
    await cookieCredential(packageId);
    const upstream = recordingUpstream((url) =>
      url.endsWith("/cart/add")
        ? redirect("https://8.8.8.8/elsewhere", "PHPSESSID=new; Path=/")
        : new Response("{}", { status: 200 }),
    );

    await expect(call(packageId, "https://1.1.1.1/cart/add", upstream.fetchImpl)).rejects.toThrow();
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);

    expect(upstream.seen.map((s) => s.request)).toEqual([
      "POST https://1.1.1.1/cart/add",
      "POST https://1.1.1.1/cart",
    ]);
    expect(upstream.seen[1]?.cookie).toBe("PHPSESSID=new");
  });

  it("falls back to the injected session on the hop after a redirect deletes the cookie", async () => {
    const packageId = "@cpcookieorg/shop";
    await cookieCredential(packageId);
    const upstream = recordingUpstream((url, n) => {
      if (n === 1) return new Response("{}", { headers: { "Set-Cookie": "PHPSESSID=rotated" } });
      if (url.endsWith("/cart/add")) return redirect("/cart", "PHPSESSID=; Max-Age=0");
      return new Response("{}", { status: 200 });
    });

    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart/add", upstream.fetchImpl);
    await call(packageId, "https://1.1.1.1/cart", upstream.fetchImpl);

    expect(upstream.seen.map((s) => s.cookie)).toEqual([
      "PHPSESSID=sess-abc",
      "PHPSESSID=rotated",
      "PHPSESSID=sess-abc", // GET hop after the 302 deleted it
      "PHPSESSID=sess-abc",
    ]);
  });

  describe("origin scoping", () => {
    it("does not replay a cookie to another host matched by a glob", async () => {
      const packageId = "@cpcookieorg/glob";
      // An unbounded glob is only open to an auth the proxy injects nothing for.
      await seedProxyIntegration(
        ctx,
        localIntegrationManifest({
          name: packageId,
          displayName: "Shop",
          description: "Shop integration",
          auths: {
            api: {
              type: "custom",
              authorizedUris: ["https://*/**"],
              credentialFields: ["token"],
              requiredCredentialFields: ["token"],
              delivery: envDelivery({ TOKEN: "token" }),
            },
          },
        }),
      );
      await seedProxyConnection(ctx, packageId, "api", { token: "tok" });
      const upstream = scriptedUpstream([["a=1"]]);

      await call(packageId, "https://1.1.1.1/x", upstream.fetchImpl);
      await call(packageId, "https://8.8.8.8/x", upstream.fetchImpl);
      await call(packageId, "https://1.1.1.1/x", upstream.fetchImpl);

      expect(upstream.seen[1]?.get("cookie")).toBeNull();
      expect(cookiePairs(upstream.seen[2]?.get("cookie"))).toEqual(["a=1"]);
    });

    it("never shares cookies between hosts rendered from connection fields", async () => {
      const packageId = "@cpcookieorg/rendered";
      await seedProxyIntegration(
        ctx,
        localIntegrationManifest({
          name: packageId,
          displayName: "Shop",
          description: "Shop integration",
          auths: {
            api: {
              type: "custom",
              authorizedUris: [
                "https://{$credential.host_a}/**",
                "https://{$credential.host_b}/**",
              ],
              credentialFields: ["host_a", "host_b"],
              requiredCredentialFields: ["host_a", "host_b"],
              delivery: envDelivery({ HOST_A: "host_a", HOST_B: "host_b" }),
            },
          },
        }),
      );
      await seedProxyConnection(ctx, packageId, "api", { host_a: "1.1.1.1", host_b: "8.8.8.8" });
      const upstream = scriptedUpstream([["a=1"]]);

      await call(packageId, "https://1.1.1.1/x", upstream.fetchImpl);
      await call(packageId, "https://8.8.8.8/x", upstream.fetchImpl);

      expect(upstream.seen).toHaveLength(2);
      expect(upstream.seen[1]?.get("cookie")).toBeNull();
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

      expect(cookiePairs(upstream.seen[1]?.get("cookie"))).toEqual(["a=1"]);
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
    expect(cookiePairs(upstream.seen[1]?.get("cookie"))).toEqual(["sid=abc"]);
  });
});
