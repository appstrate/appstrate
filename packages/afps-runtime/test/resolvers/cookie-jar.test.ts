// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the sticky-cookie jar shared by the sidecar and platform
 * credential proxies, and for the redirect follower's use of it.
 */

import { describe, it, expect, mock } from "bun:test";
import {
  composeCookieHeader,
  cookieBucketKey,
  eligibleCookies,
  mergeSetCookieIntoJar,
  originOf,
  type CookieJar,
} from "../../src/resolvers/cookie-jar.ts";
import { fetchFollowingRedirectsCapturingCookies } from "../../src/resolvers/api-call-engine.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const KEY = "bucket";

function merge(jar: CookieJar, ...headers: string[]): CookieJar {
  mergeSetCookieIntoJar(headers, jar, KEY, NOW);
  return jar;
}

describe("mergeSetCookieIntoJar", () => {
  it("strips attributes and upserts by name", () => {
    const jar = merge(new Map(), "a=1; Path=/; HttpOnly", "b=2; Secure");
    expect(jar.get(KEY)).toEqual(["a=1", "b=2"]);
    merge(jar, "a=3; SameSite=Lax");
    expect(jar.get(KEY)).toEqual(["a=3", "b=2"]);
  });

  it("trims the name and the value", () => {
    expect(merge(new Map(), "  a = 1 ; Path=/").get(KEY)).toEqual(["a=1"]);
  });

  it("deletes on Max-Age=0, matching the attribute case-insensitively", () => {
    const jar = merge(new Map(), "a=1", "b=2");
    merge(jar, "a=; max-AGE=0");
    expect(jar.get(KEY)).toEqual(["b=2"]);
  });

  it("deletes on a negative Max-Age", () => {
    expect(merge(merge(new Map(), "a=1", "b=2"), "a=x; Max-Age=-1").get(KEY)).toEqual(["b=2"]);
  });

  it("deletes on an Expires in the past", () => {
    const jar = merge(new Map(), "a=1", "b=2");
    merge(jar, "a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(jar.get(KEY)).toEqual(["b=2"]);
  });

  it("keeps a cookie whose Expires is in the future", () => {
    const jar = merge(new Map(), "a=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT");
    expect(jar.get(KEY)).toEqual(["a=1"]);
  });

  it("lets Max-Age take precedence over a past Expires", () => {
    const jar = merge(new Map(), "a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600");
    expect(jar.get(KEY)).toEqual(["a=1"]);
  });

  it("ignores an unparseable Max-Age and Expires", () => {
    const jar = merge(new Map(), "a=1; Max-Age=soon; Expires=never");
    expect(jar.get(KEY)).toEqual(["a=1"]);
  });

  it("ignores a header without `=` or with an empty name", () => {
    const jar = merge(new Map(), "a=1");
    merge(jar, "garbage; Path=/", "=value", "  =x");
    expect(jar.get(KEY)).toEqual(["a=1"]);
    expect(merge(new Map(), "garbage").has(KEY)).toBe(false);
  });

  it("drops the bucket key once its last cookie is deleted", () => {
    const jar = merge(new Map(), "a=1");
    merge(jar, "a=; Max-Age=0");
    expect(jar.has(KEY)).toBe(false);
  });

  it("never creates a bucket for a deletion of an unknown cookie", () => {
    expect(merge(new Map(), "a=; Max-Age=0").has(KEY)).toBe(false);
  });

  it("leaves other buckets untouched", () => {
    const jar: CookieJar = new Map([["other", ["a=1"]]]);
    merge(jar, "a=2");
    expect(jar.get("other")).toEqual(["a=1"]);
  });
});

describe("composeCookieHeader", () => {
  it("overlay wins by name and other base names are kept", () => {
    expect(
      composeCookieHeader("PHPSESSID=injected; theme=dark", ["PHPSESSID=rotated", "p=1"]),
    ).toBe("PHPSESSID=rotated; theme=dark; p=1");
  });

  it("returns the base alone when the overlay is empty", () => {
    expect(composeCookieHeader("a=1;  b=2 ;", [])).toBe("a=1; b=2");
  });

  it("returns the overlay alone when the base is empty", () => {
    expect(composeCookieHeader(null, ["a=1"])).toBe("a=1");
    expect(composeCookieHeader("  ", ["a=1", " "])).toBe("a=1");
  });

  it("returns undefined when both are empty", () => {
    expect(composeCookieHeader(undefined, [])).toBeUndefined();
    expect(composeCookieHeader(" ; ", [""])).toBeUndefined();
  });
});

describe("originOf", () => {
  it("returns the WHATWG origin, or the opaque origin when unparseable", () => {
    expect(originOf("https://api.example.com:443/x?y")).toBe("https://api.example.com");
    expect(originOf("not a url")).toBe("null");
  });
});

describe("eligibleCookies", () => {
  const API = "https://api.example.com";
  const CONTENT = "https://content.example.com";

  it("returns a same-origin bucket whatever the gate", () => {
    const jar: CookieJar = new Map([[cookieBucketKey("i", "open", API), ["a=1"]]]);
    expect([...eligibleCookies(jar, "i", "open", API).values()]).toEqual(["a=1"]);
    expect([...eligibleCookies(jar, "i", "allowlist", API).values()]).toEqual(["a=1"]);
  });

  it("folds sibling allowlist buckets only into an allowlist-gated call", () => {
    const jar: CookieJar = new Map([[cookieBucketKey("i", "allowlist", CONTENT), ["a=1"]]]);
    expect([...eligibleCookies(jar, "i", "allowlist", API).values()]).toEqual(["a=1"]);
    expect(eligibleCookies(jar, "i", "open", API).size).toBe(0);
  });

  it("never lends an open bucket to another origin", () => {
    const jar: CookieJar = new Map([[cookieBucketKey("i", "open", CONTENT), ["a=1"]]]);
    expect(eligibleCookies(jar, "i", "allowlist", API).size).toBe(0);
  });

  it("never reads another integration's buckets", () => {
    const jar: CookieJar = new Map([[cookieBucketKey("other", "allowlist", API), ["a=1"]]]);
    expect(eligibleCookies(jar, "i", "allowlist", API).size).toBe(0);
  });

  it("lets the same-origin value win over a sibling of the same name", () => {
    const jar: CookieJar = new Map([
      [cookieBucketKey("i", "allowlist", API), ["s=fresh"]],
      [cookieBucketKey("i", "allowlist", CONTENT), ["s=stale"]],
    ]);
    expect(eligibleCookies(jar, "i", "allowlist", API).get("s")).toBe("s=fresh");
  });
});

describe("fetchFollowingRedirectsCapturingCookies — jar bucket", () => {
  it("writes every hop under cookieJarKey and applies a hop's deletion", async () => {
    const cookiesSeen: (string | null)[] = [];
    const fetchFn = mock(async (url: string | URL, init?: RequestInit) => {
      cookiesSeen.push(new Headers(init?.headers).get("cookie"));
      const u = String(url);
      if (u.endsWith("/a")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://api.example.com/b", "set-cookie": "sess=1" },
        });
      }
      return new Response("ok", {
        status: 200,
        headers: [
          ["set-cookie", "stale=; Max-Age=0"],
          ["set-cookie", "last=2"],
        ],
      });
    });
    const jar: CookieJar = new Map([["call-key", ["stale=old"]]]);

    await fetchFollowingRedirectsCapturingCookies({
      url: "https://api.example.com/a",
      init: { method: "GET", headers: { cookie: "caller=c" } },
      fetchFn: fetchFn as unknown as typeof fetch,
      cookieJar: jar,
      cookieJarKey: "call-key",
      integrationId: "demo",
      injectedCredentialHeader: null,
      authorizedUris: ["https://api.example.com/**"],
      resolveHost: async () => ["203.0.113.7"],
    });

    expect(cookiesSeen).toEqual(["caller=c", "caller=c; stale=old; sess=1"]);
    expect(jar.get("call-key")).toEqual(["sess=1", "last=2"]);
    expect([...jar.keys()]).toEqual(["call-key"]);
  });
});
