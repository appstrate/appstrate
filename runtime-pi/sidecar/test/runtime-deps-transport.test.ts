// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime deps `server.ts` builds carry no transport override, so an `api_call` reaches the
 * global `fetch` through `fetchApiCall`'s address pin. An override is for tests only.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { buildSidecarRuntimeDeps } from "../app.ts";
import { executeApiCall } from "../credential-proxy.ts";
import { TEST_EGRESS_ALLOW_INTERNAL_HOSTS } from "./helpers/egress-hosts.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The deps exactly as `server.ts` builds them: no `fetchFn`. */
const productionDeps = () =>
  buildSidecarRuntimeDeps({
    config: { platformApiUrl: "http://platform:3000", runToken: "tok", proxyUrl: "" },
    cookieJar: new Map(),
    egressAllowInternalHosts: TEST_EGRESS_ALLOW_INTERNAL_HOSTS,
  });

describe("sidecar runtime deps — api_call transport", () => {
  it("production wiring passes no transport override", () => {
    expect(productionDeps().proxyDeps.fetchFn).toBeUndefined();
  });

  it("a production api_call connects to the DNS-validated address", async () => {
    const seen: Array<{ url: string; host: string | null }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, host: new Headers(init?.headers).get("host") });
      return new Response("{}");
    }) as unknown as typeof fetch;

    const result = await executeApiCall(
      {
        integrationId: "@appstrate/test",
        connectionId: "conn-1",
        targetUrl: "https://api.example.com/v1/me",
        method: "GET",
        callerHeaders: {},
        body: { kind: "none" },
      },
      {
        ...productionDeps().proxyDeps,
        // A glob host: `api.example.com` named literally would skip the SSRF gate (the test
        // preload lists it in EGRESS_ALLOW_INTERNAL_HOSTS), and with it the pin.
        declaredUris: ["https://*.example.com/**"],
        resolveHost: async () => ["203.0.113.9"],
        fetchCredentials: async () => ({
          credentials: { api_key: "k" },
          authorizedUris: ["https://*.example.com/**"],
          allowAllUris: false,
          credentialHeaderName: "X-Api-Key",
          credentialFieldName: "api_key",
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ url: "https://203.0.113.9/v1/me", host: "api.example.com" }]);
  });
});
