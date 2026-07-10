// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { guardedFetch, SsrfBlockedError } from "../src/guarded-fetch.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Resolver that maps a host to fixed addresses. */
function resolverFor(map: Record<string, string[]>) {
  return async (host: string) => map[host] ?? ["203.0.113.10"]; // default public
}

describe("guardedFetch — SSRF", () => {
  it("blocks a public hostname that resolves to a private address (DNS rebind)", async () => {
    globalThis.fetch = (async () =>
      new Response("should not reach", { status: 200 })) as unknown as typeof fetch;
    await expect(
      guardedFetch("https://rebind.attacker.example/x", undefined, {
        resolve: resolverFor({ "rebind.attacker.example": ["169.254.169.254"] }),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks a literal loopback/link-local URL", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 200 })) as unknown as typeof fetch;
    await expect(guardedFetch("http://127.0.0.1/x")).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(guardedFetch("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(guardedFetch("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows a public host and pins the connection to the validated address", async () => {
    let seenHost: string | null = null;
    let seenTls: unknown;
    globalThis.fetch = (async (input: string | URL | Request, reqInit?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenHost = new Headers(reqInit?.headers ?? {}).get("host");
      seenTls = (reqInit as { tls?: unknown } | undefined)?.tls;
      return new Response(`ok:${url}`, { status: 200 });
    }) as unknown as typeof fetch;
    const res = await guardedFetch("https://public.example/data", undefined, {
      resolve: resolverFor({ "public.example": ["203.0.113.5"] }),
    });
    expect(res.status).toBe(200);
    // The wire connection goes to the DNS-validated address (TOCTOU closed) …
    expect(await res.text()).toContain("203.0.113.5");
    // … while the logical hostname is preserved on the wire (Host) and in the
    // TLS handshake (SNI + certificate identity via serverName).
    expect(seenHost as string | null).toBe("public.example");
    expect(seenTls as { serverName?: string } | undefined).toEqual({
      serverName: "public.example",
    });
  });

  it("does not pin when a fetchImpl transport seam is injected", async () => {
    let seenUrl = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await guardedFetch("https://public.example/data", undefined, {
      fetchImpl,
      resolve: resolverFor({ "public.example": ["203.0.113.5"] }),
    });
    expect(res.status).toBe(200);
    expect(seenUrl).toContain("public.example");
  });

  it("does not pin when pinToResolvedAddress is false", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await guardedFetch("https://public.example/data", undefined, {
      pinToResolvedAddress: false,
      resolve: resolverFor({ "public.example": ["203.0.113.5"] }),
    });
    expect(seenUrl).toContain("public.example");
  });

  it("re-pins each redirect hop to that hop's validated address", async () => {
    const seen: Array<{ url: string; host: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, reqInit?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, host: new Headers(reqInit?.headers ?? {}).get("host") });
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://second.example/final" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof fetch;

    await guardedFetch("https://first.example/start", undefined, {
      resolve: resolverFor({ "first.example": ["203.0.113.1"], "second.example": ["203.0.113.2"] }),
    });
    expect(seen[0]!.url).toContain("203.0.113.1");
    expect(seen[0]!.host).toBe("first.example");
    expect(seen[1]!.url).toContain("203.0.113.2");
    expect(seen[1]!.host).toBe("second.example");
  });

  it("re-checks each redirect hop and blocks a redirect to an internal host", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://rebind.internal.example/steal" },
        });
      }
      return new Response("leaked", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      guardedFetch("https://public.example/start", undefined, {
        resolve: resolverFor({
          "public.example": ["203.0.113.5"],
          "rebind.internal.example": ["10.0.0.5"],
        }),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(call).toBe(1); // second (leaking) fetch never happened
  });

  it("follows a redirect to another public host", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://second.example/final" },
        });
      }
      return new Response("final-body", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await guardedFetch("https://first.example/start", undefined, {
      resolve: resolverFor({ "first.example": ["203.0.113.1"], "second.example": ["203.0.113.2"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("final-body");
  });

  it("drops Authorization/Cookie on a cross-origin redirect but keeps them same-origin", async () => {
    const seen: Array<{ auth: string | null }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, reqInit?: RequestInit) => {
      const auth = new Headers(reqInit?.headers ?? {}).get("authorization");
      seen.push({ auth });
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://first.example/same" },
        });
      }
      if (seen.length === 2) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example/final" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof fetch;

    await guardedFetch(
      "https://first.example/start",
      { headers: { Authorization: "Bearer secret" } },
      {
        resolve: resolverFor({
          "first.example": ["203.0.113.1"],
          "other.example": ["203.0.113.2"],
        }),
      },
    );
    expect(seen[0]!.auth).toBe("Bearer secret"); // initial request
    expect(seen[1]!.auth).toBe("Bearer secret"); // same-origin hop keeps it
    expect(seen[2]!.auth).toBeNull(); // cross-origin hop dropped it
  });

  it("drops the request body (and content-type) on a cross-host 307 redirect", async () => {
    const seen: Array<{ body: unknown; contentType: string | null }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, reqInit?: RequestInit) => {
      seen.push({
        body: reqInit?.body,
        contentType: new Headers(reqInit?.headers ?? {}).get("content-type"),
      });
      if (seen.length === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: "https://other.example/token" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof fetch;

    await guardedFetch(
      "https://first.example/token",
      {
        method: "POST",
        body: "client_secret=shh",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      {
        resolve: resolverFor({
          "first.example": ["203.0.113.1"],
          "other.example": ["203.0.113.2"],
        }),
      },
    );
    expect(seen[0]!.body).toBe("client_secret=shh");
    expect(seen[1]!.body).toBeUndefined();
    expect(seen[1]!.contentType).toBeNull();
  });

  it("preserves the request body on a same-host http→https 307 upgrade", async () => {
    // A TLS-terminating reverse proxy in front of an (allowlisted) internal
    // IdP routinely 307-upgrades http→https on the same host — the host
    // boundary is what the secret-containment drop keys on, not the origin.
    const seen: Array<{ body: unknown }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, reqInit?: RequestInit) => {
      seen.push({ body: reqInit?.body });
      if (seen.length === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: "https://idp.example/token" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof fetch;

    await guardedFetch(
      "http://idp.example/token",
      { method: "POST", body: "grant_type=refresh_token" },
      { resolve: resolverFor({ "idp.example": ["203.0.113.9"] }) },
    );
    expect(seen[1]!.body).toBe("grant_type=refresh_token");
  });

  it("drops the request body on a same-host https→http downgrade", async () => {
    // Same host, but the secret would be re-sent in cleartext — drop it.
    const seen: Array<{ body: unknown }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, reqInit?: RequestInit) => {
      seen.push({ body: reqInit?.body });
      if (seen.length === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: "http://idp.example/token" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof fetch;

    await guardedFetch(
      "https://idp.example/token",
      { method: "POST", body: "client_secret=shh" },
      { resolve: resolverFor({ "idp.example": ["203.0.113.9"] }) },
    );
    expect(seen[1]!.body).toBeUndefined();
  });

  it("stops after maxRedirects", async () => {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://loop.example/next" },
      })) as unknown as typeof fetch;
    await expect(
      guardedFetch("https://loop.example/x", undefined, {
        maxRedirects: 2,
        resolve: resolverFor({ "loop.example": ["203.0.113.9"] }),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe("guardedFetch — caller hop contract (validateHop / sensitiveHeaders)", () => {
  class HopRejectedError extends Error {}

  /** validateHop that only admits URLs under https://api.vendor.example/v1/ */
  const allowV1Only = (url: URL) => {
    if (url.origin !== "https://api.vendor.example" || !url.pathname.startsWith("/v1/")) {
      throw new HopRejectedError(`off-allowlist hop: ${url.origin}${url.pathname}`);
    }
  };

  it("calls validateHop on hop 0 with the logical URL, before any fetch", async () => {
    const hops: Array<{ href: string; hop: number }> = [];
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await guardedFetch("https://api.vendor.example/v1/me#frag", undefined, {
      resolve: resolverFor({ "api.vendor.example": ["203.0.113.5"] }),
      validateHop: (url, hop) => {
        hops.push({ href: url.href, hop });
        allowV1Only(url);
      },
    });
    // Logical URL: fragment stripped, hostname NOT the pinned address.
    expect(hops).toEqual([{ href: "https://api.vendor.example/v1/me", hop: 0 }]);
    expect(fetched).toBe(1);

    // A hop-0 rejection aborts before ANY request goes out.
    fetched = 0;
    await expect(
      guardedFetch("https://evil.example/v1/me", undefined, {
        resolve: resolverFor({ "evil.example": ["203.0.113.6"] }),
        validateHop: allowV1Only,
      }),
    ).rejects.toBeInstanceOf(HopRejectedError);
    expect(fetched).toBe(0);
  });

  it("aborts on a cross-host redirect that leaves the allowlist", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/v1/steal" },
        });
      }
      return new Response("leaked", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      guardedFetch(
        "https://api.vendor.example/v1/me",
        { headers: { "X-Api-Key": "sk-secret" } },
        {
          resolve: resolverFor({
            "api.vendor.example": ["203.0.113.5"],
            "attacker.example": ["203.0.113.66"],
          }),
          validateHop: allowV1Only,
          sensitiveHeaders: ["X-Api-Key"],
        },
      ),
    ).rejects.toBeInstanceOf(HopRejectedError);
    expect(call).toBe(1); // the off-allowlist hop was never fetched
  });

  it("aborts on a SAME-host redirect that walks off the allowlisted path", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "/internal/dump" }, // same origin, off-path
        });
      }
      return new Response("leaked", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      guardedFetch("https://api.vendor.example/v1/me", undefined, {
        resolve: resolverFor({ "api.vendor.example": ["203.0.113.5"] }),
        validateHop: allowV1Only,
      }),
    ).rejects.toBeInstanceOf(HopRejectedError);
    expect(call).toBe(1);
  });

  it("runs validateHop on every hop with increasing indices when all hops conform", async () => {
    const hops: number[] = [];
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://api.vendor.example/v1/other" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await guardedFetch("https://api.vendor.example/v1/me", undefined, {
      resolve: resolverFor({ "api.vendor.example": ["203.0.113.5"] }),
      validateHop: (url, hop) => {
        hops.push(hop);
        allowV1Only(url);
      },
    });
    expect(res.status).toBe(200);
    expect(hops).toEqual([0, 1]);
  });

  it("strips caller-declared sensitive headers (X-Api-Key) on a cross-origin hop, keeps them same-origin, and still strips the builtin set", async () => {
    const seen: Array<{ apiKey: string | null; auth: string | null }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, reqInit?: RequestInit) => {
      const h = new Headers(reqInit?.headers ?? {});
      seen.push({ apiKey: h.get("x-api-key"), auth: h.get("authorization") });
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://first.example/same-origin" },
        });
      }
      if (seen.length === 2) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example/final" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof fetch;

    await guardedFetch(
      "https://first.example/start",
      { headers: { "X-Api-Key": "sk-secret", Authorization: "Bearer tok" } },
      {
        resolve: resolverFor({
          "first.example": ["203.0.113.1"],
          "other.example": ["203.0.113.2"],
        }),
        sensitiveHeaders: ["X-Api-Key"], // case-insensitive union with builtins
      },
    );
    expect(seen[0]).toEqual({ apiKey: "sk-secret", auth: "Bearer tok" }); // initial
    expect(seen[1]).toEqual({ apiKey: "sk-secret", auth: "Bearer tok" }); // same-origin keeps both
    expect(seen[2]).toEqual({ apiKey: null, auth: null }); // cross-origin drops the union set
  });

  it("does NOT strip a custom header when sensitiveHeaders is absent (pre-existing default, callers must declare)", async () => {
    const seen: Array<string | null> = [];
    globalThis.fetch = (async (_input: string | URL | Request, reqInit?: RequestInit) => {
      seen.push(new Headers(reqInit?.headers ?? {}).get("x-api-key"));
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example/final" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof fetch;

    await guardedFetch(
      "https://first.example/start",
      { headers: { "X-Api-Key": "sk-visible" } },
      {
        resolve: resolverFor({
          "first.example": ["203.0.113.1"],
          "other.example": ["203.0.113.2"],
        }),
      },
    );
    expect(seen[1]).toBe("sk-visible");
  });

  it("drops the body on a same-host cross-origin (http→https) 307 hop when validateHop is present", async () => {
    // Without a hop contract the same-host upgrade keeps the body (see the
    // dedicated test above); with one, ANY origin change drops it.
    const seen: Array<{ body: unknown }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, reqInit?: RequestInit) => {
      seen.push({ body: reqInit?.body });
      if (seen.length === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: "https://idp.example/token" },
        });
      }
      return new Response("done", { status: 200 });
    }) as unknown as typeof fetch;

    await guardedFetch(
      "http://idp.example/token",
      { method: "POST", body: "client_secret=shh" },
      {
        resolve: resolverFor({ "idp.example": ["203.0.113.9"] }),
        validateHop: () => {}, // permissive contract — presence alone tightens body policy
      },
    );
    expect(seen[0]!.body).toBe("client_secret=shh");
    expect(seen[1]!.body).toBeUndefined();
  });
});
