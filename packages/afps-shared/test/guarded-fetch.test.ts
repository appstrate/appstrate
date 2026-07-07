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

  it("allows a public host and returns the response", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(`ok:${url}`, { status: 200 });
    }) as unknown as typeof fetch;
    const res = await guardedFetch("https://public.example/data", undefined, {
      resolve: resolverFor({ "public.example": ["203.0.113.5"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("public.example");
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
