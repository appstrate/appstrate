// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Phase 3b deprecation headers (RFC 9745 / RFC 8594).
 *
 * The legacy /llm/* and /proxy?X-Stream-Response branches advertise
 * their phase-out via standard HTTP headers so external operator
 * tooling can surface the migration deadline without parsing log
 * lines. The plan §V6 commits to an 18-month removal cycle.
 */

import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import {
  DEPRECATION_DATE,
  DEPRECATION_HEADERS,
  MIGRATION_GUIDE_URL,
  SUNSET_DATE,
} from "../deprecation.ts";
import type { CredentialsResponse } from "../helpers.ts";

function makeDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: {
      platformApiUrl: "http://mock:3000",
      runToken: "tok",
      proxyUrl: "",
      llm: {
        baseUrl: "https://llm.example.com",
        apiKey: "real",
        placeholder: "sk-placeholder",
      },
    },
    fetchCredentials: mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "test-123" },
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
      }),
    ),
    cookieJar: new Map(),
    fetchFn: mock(
      async () =>
        new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
    ) as unknown as typeof fetch,
    isReady: () => true,
    runId: "run-test",
    ...overrides,
  };
}

describe("DEPRECATION_HEADERS contract", () => {
  it("returns RFC 9745 Deprecation, RFC 8594 Sunset, and Link header", () => {
    expect(DEPRECATION_HEADERS).toHaveProperty("Deprecation", DEPRECATION_DATE);
    expect(DEPRECATION_HEADERS).toHaveProperty("Sunset", SUNSET_DATE);
    expect(DEPRECATION_HEADERS).toHaveProperty("Link");
    expect(DEPRECATION_HEADERS.Link).toContain(MIGRATION_GUIDE_URL);
    expect(DEPRECATION_HEADERS.Link).toContain('rel="sunset"');
  });

  it("Sunset date is at least 18 months past Deprecation date", () => {
    const dep = Date.parse(DEPRECATION_DATE);
    const sun = Date.parse(SUNSET_DATE);
    expect(sun - dep).toBeGreaterThanOrEqual(18 * 30 * 24 * 60 * 60 * 1000);
  });
});

describe("/llm/* deprecation headers", () => {
  it("attaches Deprecation + Sunset on every response", async () => {
    const app = createApp(
      makeDeps({
        fetchFn: mock(
          async () =>
            new Response('{"ok":true}', {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ) as unknown as typeof fetch,
      }),
    );
    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"x":1}',
    });
    expect(res.headers.get("Deprecation")).toBe(DEPRECATION_DATE);
    expect(res.headers.get("Sunset")).toBe(SUNSET_DATE);
    expect(res.headers.get("Link")).toContain('rel="sunset"');
  });

  it("attaches deprecation headers even on upstream error", async () => {
    const app = createApp(
      makeDeps({
        fetchFn: mock(
          async () =>
            new Response("rate-limited", {
              status: 429,
              headers: { "Content-Type": "text/plain" },
            }),
        ) as unknown as typeof fetch,
      }),
    );
    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"x":1}',
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Deprecation")).toBe(DEPRECATION_DATE);
  });
});

describe("/proxy?X-Stream-Response deprecation headers", () => {
  it("attaches Deprecation + Sunset only on the streaming branch", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "test-provider",
        "X-Target": "https://api.example.com/document.pdf",
        "X-Stream-Response": "1",
      },
    });
    expect(res.headers.get("Deprecation")).toBe(DEPRECATION_DATE);
    expect(res.headers.get("Sunset")).toBe(SUNSET_DATE);
  });

  it("does NOT attach deprecation headers on the buffered branch (still load-bearing)", async () => {
    const app = createApp(
      makeDeps({
        fetchFn: mock(
          async () =>
            new Response('{"ok":true}', {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ) as unknown as typeof fetch,
      }),
    );
    const res = await app.request("/proxy", {
      method: "GET",
      headers: {
        "X-Provider": "test-provider",
        "X-Target": "https://api.example.com/ping",
      },
    });
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
  });
});
