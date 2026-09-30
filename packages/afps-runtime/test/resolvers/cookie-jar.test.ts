// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the sticky-cookie scope shared by the sidecar and platform
 * credential proxies, and for the redirect follower's use of it.
 */

import { describe, it, expect, mock } from "bun:test";
import { cookieScope, type CookieJar } from "../../src/resolvers/cookie-jar.ts";
import { fetchApiCall } from "../../src/resolvers/api-call-engine.ts";

const API = "https://api.example.com/x";
const CONTENT = "https://content.example.com/x";
const LITERAL = [
  "https://api.example.com/**",
  "https://content.example.com/**",
  "https://*.glob.example/**",
];

/** Own-origin cookies of `url` (open policy: no sibling fold, no base). */
const ownCookies = (jar: CookieJar, url: string, id = "i") =>
  cookieScope(jar, id, null).header(url, null);

describe("cookieScope.capture", () => {
  it("strips attributes, trims, and upserts by name", () => {
    const jar: CookieJar = new Map();
    const scope = cookieScope(jar, "i", null);
    scope.capture(API, ["a=1; Path=/; HttpOnly", "  b = 2 ; Secure"]);
    scope.capture(API, ["a=3; SameSite=Lax"]);
    expect(ownCookies(jar, API)).toBe("b=2; a=3");
  });

  it.each([
    ["Max-Age=0, attribute matched case-insensitively", "a=; max-AGE=0"],
    ["a negative Max-Age", "a=x; Max-Age=-1"],
    ["an Expires in the past", "a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT"],
  ])("deletes on %s", (_label, deletion) => {
    const jar: CookieJar = new Map();
    const scope = cookieScope(jar, "i", null);
    scope.capture(API, ["a=1", "b=2"]);
    scope.capture(API, [deletion]);
    expect(ownCookies(jar, API)).toBe("b=2");
  });

  it.each([
    ["a future Expires", "a=1; Expires=Fri, 01 Jan 2999 00:00:00 GMT"],
    [
      "a positive Max-Age over a past Expires",
      "a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600",
    ],
    ["an unparseable Max-Age and Expires", "a=1; Max-Age=soon; Expires=never"],
  ])("keeps a cookie with %s", (_label, header) => {
    const jar: CookieJar = new Map();
    cookieScope(jar, "i", null).capture(API, [header]);
    expect(ownCookies(jar, API)).toBe("a=1");
  });

  it("ignores a header without `=` or with an empty name", () => {
    const jar: CookieJar = new Map();
    cookieScope(jar, "i", null).capture(API, ["a=1", "garbage; Path=/", "=value", "  =x"]);
    expect(ownCookies(jar, API)).toBe("a=1");
  });

  it("caps a bucket at 50 cookies, evicting the least recently set names", () => {
    const jar: CookieJar = new Map();
    const scope = cookieScope(jar, "i", null);
    scope.capture(
      API,
      Array.from({ length: 50 }, (_, n) => `c${n}=${n}`),
    );
    scope.capture(API, ["c50=50"]);
    const names = ownCookies(jar, API)!
      .split("; ")
      .map((p) => p.split("=")[0]);
    expect(names).toHaveLength(50);
    expect(names).not.toContain("c0");
    expect(names.at(-1)).toBe("c50");
  });

  it("keeps a cookie re-set on every response over per-request names", () => {
    const jar: CookieJar = new Map();
    const scope = cookieScope(jar, "i", null);
    scope.capture(API, ["PHPSESSID=v0"]);
    scope.capture(
      API,
      Array.from({ length: 49 }, (_, n) => `nonce_${n + 1}=x`),
    );
    scope.capture(API, ["PHPSESSID=v1", "nonce_50=x"]);
    const pairs = ownCookies(jar, API)!.split("; ");
    expect(pairs).toHaveLength(50);
    expect(pairs).toContain("PHPSESSID=v1");
    expect(pairs.some((p) => p.startsWith("nonce_1="))).toBe(false);
  });

  it("drops the bucket once its last cookie is deleted", () => {
    const jar: CookieJar = new Map();
    const scope = cookieScope(jar, "i", null);
    scope.capture(API, ["a=1"]);
    scope.capture(API, ["a=; Max-Age=0"]);
    expect(jar.size).toBe(0);
  });
});

describe("cookieScope.header", () => {
  it("lets an own-origin cookie win by name over the base and keeps the other base names", () => {
    const jar: CookieJar = new Map();
    const scope = cookieScope(jar, "i", null);
    scope.capture(API, ["PHPSESSID=rotated", "p=1"]);
    expect(scope.header(API, "PHPSESSID=injected; theme=dark")).toBe(
      "PHPSESSID=rotated; theme=dark; p=1",
    );
  });

  it("normalises the base and returns undefined when nothing is left", () => {
    const scope = cookieScope(new Map(), "i", null);
    expect(scope.header(API, "a=1;  b=2 ;")).toBe("a=1; b=2");
    expect(scope.header(API, " ; ")).toBeUndefined();
    expect(scope.header(API, undefined)).toBeUndefined();
  });

  it("never lends a cookie to another origin under an open policy", () => {
    const jar: CookieJar = new Map();
    cookieScope(jar, "i", null).capture(CONTENT, ["a=1"]);
    expect(cookieScope(jar, "i", null).header(API, null)).toBeUndefined();
    expect(cookieScope(jar, "i", LITERAL).header(API, null)).toBeUndefined();
  });

  it("folds a literal sibling's cookies under the base, and the own origin over both", () => {
    const jar: CookieJar = new Map();
    const scope = cookieScope(jar, "i", LITERAL);
    scope.capture(CONTENT, ["PHPSESSID=anon", "cdn=1"]);
    expect(scope.header(API, null)).toBe("PHPSESSID=anon; cdn=1");
    expect(scope.header(API, "PHPSESSID=injected")).toBe("PHPSESSID=injected; cdn=1");
    scope.capture(API, ["PHPSESSID=rotated"]);
    expect(scope.header(API, "PHPSESSID=injected")).toBe("PHPSESSID=rotated; cdn=1");
  });

  it("does not share cookies across hosts a glob entry matched", () => {
    const jar: CookieJar = new Map();
    const scope = cookieScope(jar, "i", LITERAL);
    scope.capture("https://victim.glob.example/", ["s=victim"]);
    expect(scope.header("https://attacker.glob.example/", null)).toBeUndefined();
    expect(scope.header(API, null)).toBeUndefined();
    expect(scope.header("https://victim.glob.example/y", null)).toBe("s=victim");
  });

  it("never reads another integration's buckets", () => {
    const jar: CookieJar = new Map();
    cookieScope(jar, "other", LITERAL).capture(API, ["a=1"]);
    cookieScope(jar, "other", LITERAL).capture(CONTENT, ["b=1"]);
    expect(cookieScope(jar, "i", LITERAL).header(API, null)).toBeUndefined();
  });
});

describe("fetchApiCall — a caller's cookie scope", () => {
  /** Records the `Cookie` header of every hop; `routes` maps a URL to its response. */
  function routedFetch(routes: Record<string, () => Response>) {
    const seen: (string | null)[] = [];
    const fetchFn = mock(async (url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("cookie"));
      return (routes[String(url)] ?? (() => new Response("ok")))();
    });
    return { seen, fetchFn: fetchFn as unknown as typeof fetch };
  }
  const redirect = (location: string, setCookie?: string) =>
    new Response(null, {
      status: 302,
      headers: { location, ...(setCookie ? { "set-cookie": setCookie } : {}) },
    });
  function follow(
    url: string,
    cookie: string,
    fetchFn: typeof fetch,
    jar: CookieJar,
    policy: { authorizedUris?: string[]; allowAllUris?: boolean },
  ) {
    return fetchApiCall({
      url,
      init: { method: "GET", headers: { cookie } },
      fetchFn,
      cookies: cookieScope(jar, "i", null),
      integrationId: "i",
      credentialHeaders: ["cookie"],
      authorizedUris: policy.authorizedUris ?? [],
      declaredUris: policy.authorizedUris ?? [],
      allowAllUris: policy.allowAllUris ?? false,
      trustedHost: () => false,
      resolveHost: async () => ["203.0.113.7"],
    });
  }

  it("captures every same-origin hop, applies a hop's deletion, and carries the initial Cookie", async () => {
    const { seen, fetchFn } = routedFetch({
      "https://api.example.com/a": () => redirect("https://api.example.com/b", "sess=1"),
      "https://api.example.com/b": () =>
        new Response("ok", {
          headers: [
            ["set-cookie", "stale=; Max-Age=0"],
            ["set-cookie", "last=2"],
          ],
        }),
    });
    const jar: CookieJar = new Map();
    cookieScope(jar, "i", null).capture(API, ["stale=old"]);

    await follow("https://api.example.com/a", "caller=c", fetchFn, jar, {
      authorizedUris: ["https://api.example.com/**"],
    });

    expect(seen).toEqual(["caller=c; stale=old", "caller=c; stale=old; sess=1"]);
    expect(ownCookies(jar, API)).toBe("sess=1; last=2");
    expect(jar.size).toBe(1);
  });

  it("falls back to the initial Cookie on the hop after a mid-chain deletion", async () => {
    const { seen, fetchFn } = routedFetch({
      "https://api.example.com/account": () =>
        redirect("https://api.example.com/login", "PHPSESSID=; Max-Age=0"),
    });
    const jar: CookieJar = new Map();
    cookieScope(jar, "i", null).capture(API, ["PHPSESSID=rotated"]);

    await follow("https://api.example.com/account", "PHPSESSID=injected", fetchFn, jar, {
      authorizedUris: ["https://api.example.com/**"],
    });

    expect(seen).toEqual(["PHPSESSID=rotated", "PHPSESSID=injected"]);
    expect(jar.size).toBe(0);
  });

  it("captures a cross-origin hop's cookie under ITS origin, not the initial one", async () => {
    const { fetchFn } = routedFetch({
      "https://victim.example/go": () => redirect("https://attacker.example/set"),
      "https://attacker.example/set": () =>
        new Response("ok", { headers: { "set-cookie": "PHPSESSID=attacker" } }),
    });
    const jar: CookieJar = new Map();

    await follow("https://victim.example/go", "PHPSESSID=victim", fetchFn, jar, {
      allowAllUris: true,
    });

    const scope = cookieScope(jar, "i", null);
    expect(scope.header("https://victim.example/next", "PHPSESSID=victim")).toBe(
      "PHPSESSID=victim",
    );
    expect(ownCookies(jar, "https://attacker.example/")).toBe("PHPSESSID=attacker");
  });

  it("never re-sends the initial Cookie once a cross-origin strip has fired", async () => {
    const { seen, fetchFn } = routedFetch({
      "https://a.example/start": () => redirect("https://evil.example/1"),
      "https://evil.example/1": () => redirect("https://evil.example/2", "e=1"),
    });

    await follow("https://a.example/start", "PHPSESSID=victim", fetchFn, new Map(), {
      allowAllUris: true,
    });

    // evil/2 gets evil's own cookie only, never the stripped session.
    expect(seen).toEqual(["PHPSESSID=victim", null, "e=1"]);
  });
});

describe("fetchApiCall — the per-call cookie scope", () => {
  const SSO = "https://sso.vendor.example/login";
  const HOME = "https://api.vendor.example/home";

  async function secondHopCookie(
    authorizedUris: string[],
    declaredUris: string[] = authorizedUris,
  ): Promise<string | null> {
    const seen: (string | null)[] = [];
    const fetchFn = mock(async (url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("cookie"));
      return String(url) === SSO
        ? new Response(null, { status: 302, headers: { location: HOME, "set-cookie": "sess=S" } })
        : new Response("ok");
    }) as unknown as typeof fetch;
    await fetchApiCall({
      url: SSO,
      init: { method: "GET" },
      fetchFn,
      authorizedUris,
      declaredUris,
      allowAllUris: false,
      credentialHeaders: [],
      trustedHost: () => false,
      integrationId: "i",
      resolveHost: async () => ["203.0.113.7"],
    });
    return seen[1] ?? null;
  }

  it("shares a hop's cookie with a literal-allowlist sibling within one chain", async () => {
    expect(
      await secondHopCookie(["https://sso.vendor.example/**", "https://api.vendor.example/**"]),
    ).toBe("sess=S");
  });

  it("keeps it origin-scoped when the literal hosts were rendered from connection values", async () => {
    expect(
      await secondHopCookie(
        ["https://sso.vendor.example/**", "https://api.vendor.example/**"],
        ["https://{$credential.sso_host}/**", "https://{$credential.api_host}/**"],
      ),
    ).toBeNull();
  });

  it("keeps it origin-scoped when a glob entry matched the hosts", async () => {
    expect(await secondHopCookie(["https://*.vendor.example/**"])).toBeNull();
  });
});
