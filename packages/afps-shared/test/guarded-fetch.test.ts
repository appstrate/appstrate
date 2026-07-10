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
