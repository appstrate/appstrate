// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Tests for per-URL TLS-client routing (issue #403). Pure routing logic — the
 * curl implementation is faked so no process is spawned.
 */

import { describe, it, expect } from "bun:test";
import type { TlsClientRoute } from "@appstrate/core/integration";
import { makeTlsClientFetch } from "../tls-client-router.ts";

function trackingFetch(label: string, calls: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    calls.push(`${label}:${url}`);
    return new Response(label, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("makeTlsClientFetch", () => {
  it("returns the default fetch unchanged when there are no routes", () => {
    const calls: string[] = [];
    const def = trackingFetch("default", calls);
    const routed = makeTlsClientFetch([], { defaultFetch: def });
    expect(routed).toBe(def);
  });

  it("routes a matching URL through curl, leaves others on the default", async () => {
    const dcalls: string[] = [];
    const curlCalls: Array<{ url: string; impersonate?: string }> = [];
    const routes: TlsClientRoute[] = [
      { urlPattern: "https://api.exotic.com/**", client: "curl", impersonate: "chrome" },
    ];
    const routed = makeTlsClientFetch(routes, {
      defaultFetch: trackingFetch("default", dcalls),
      curlFetchImpl: async (url, init) => {
        curlCalls.push({ url, impersonate: init.impersonate });
        return new Response("curl", { status: 200 });
      },
    });

    const a = await routed("https://api.exotic.com/data");
    const b = await routed("https://normal.com/data");

    expect(await a.text()).toBe("curl");
    expect(await b.text()).toBe("default");
    expect(curlCalls).toEqual([{ url: "https://api.exotic.com/data", impersonate: "chrome" }]);
    expect(dcalls).toEqual(["default:https://normal.com/data"]);
  });

  it("first match wins — a narrow undici route overrides a broad curl route", async () => {
    const dcalls: string[] = [];
    const curlCalls: string[] = [];
    const routes: TlsClientRoute[] = [
      { urlPattern: "https://api.exotic.com/open/**", client: "undici" },
      { urlPattern: "https://api.exotic.com/**", client: "curl" },
    ];
    const routed = makeTlsClientFetch(routes, {
      defaultFetch: trackingFetch("default", dcalls),
      curlFetchImpl: async (url) => {
        curlCalls.push(url);
        return new Response("curl", { status: 200 });
      },
    });

    await routed("https://api.exotic.com/open/thing"); // undici override
    await routed("https://api.exotic.com/secret"); // curl

    expect(dcalls).toEqual(["default:https://api.exotic.com/open/thing"]);
    expect(curlCalls).toEqual(["https://api.exotic.com/secret"]);
  });

  it("passes method, headers, body and signal to the curl impl", async () => {
    let seen: { method?: string; headers?: unknown; body?: unknown; signal?: unknown } = {};
    const routed = makeTlsClientFetch([{ urlPattern: "https://x/**", client: "curl" }], {
      defaultFetch: trackingFetch("default", []),
      curlFetchImpl: async (_url, init) => {
        seen = init;
        return new Response("ok", { status: 200 });
      },
    });
    const ctrl = new AbortController();
    await routed("https://x/y", {
      method: "PUT",
      headers: { "X-A": "1" },
      body: "data",
      signal: ctrl.signal,
    });
    expect(seen.method).toBe("PUT");
    expect(seen.body).toBe("data");
    expect(seen.signal).toBe(ctrl.signal);
  });

  it("accepts URL and Request first arguments", async () => {
    const curlCalls: string[] = [];
    const routed = makeTlsClientFetch([{ urlPattern: "https://x/**", client: "curl" }], {
      defaultFetch: trackingFetch("default", []),
      curlFetchImpl: async (url) => {
        curlCalls.push(url);
        return new Response("ok");
      },
    });
    await routed(new URL("https://x/from-url"));
    await routed(new Request("https://x/from-request"));
    expect(curlCalls).toEqual(["https://x/from-url", "https://x/from-request"]);
  });

  it("fires onRoute only for curl-routed requests", async () => {
    const events: string[] = [];
    const routed = makeTlsClientFetch(
      [
        { urlPattern: "https://x/curl/**", client: "curl", impersonate: "firefox" },
        { urlPattern: "https://x/plain/**", client: "undici" },
      ],
      {
        defaultFetch: trackingFetch("default", []),
        curlFetchImpl: async () => new Response("ok"),
        onRoute: (i) => events.push(`${i.client}:${i.impersonate ?? "-"}:${i.url}`),
      },
    );
    await routed("https://x/curl/a");
    await routed("https://x/plain/b");
    await routed("https://x/unmatched");
    expect(events).toEqual(["curl:firefox:https://x/curl/a"]);
  });
});
