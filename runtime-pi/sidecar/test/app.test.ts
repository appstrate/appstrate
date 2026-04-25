// SPDX-License-Identifier: Apache-2.0

/**
 * After the MCP migration, the sidecar's HTTP surface is intentionally
 * narrow: `GET /health`, `POST /configure`, and `ALL /mcp` (mounted by
 * `mountMcp`, exercised by `mcp.test.ts`). The legacy `/proxy`,
 * `/run-history`, and `/llm/*` routes are gone — every credential-
 * isolation invariant they enforced lives in the credential-proxy core
 * (`credential-proxy.test.ts`) and the MCP tool handlers (`mcp.test.ts`).
 *
 * This file covers the two remaining HTTP routes only.
 */

import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import type { CredentialsResponse } from "../helpers.ts";

function makeDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
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
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch,
    isReady: () => true,
    ...overrides,
  };
}

// --- GET /health ---

describe("GET /health", () => {
  it("returns 200 when ready", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 503 when not ready", async () => {
    const app = createApp(makeDeps({ isReady: () => false }));
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; proxy: string };
    expect(body.status).toBe("degraded");
  });

  it("response has correct content-type", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/health");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

// --- POST /configure ---

describe("POST /configure", () => {
  it("updates run token", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(deps.config.runToken).toBe("new-tok");
  });

  it("updates platformApiUrl", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ platformApiUrl: "http://new:4000" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(deps.config.platformApiUrl).toBe("http://new:4000");
  });

  it("updates proxyUrl to empty string", async () => {
    const deps = makeDeps();
    deps.config.proxyUrl = "http://proxy:8080";
    const app = createApp(deps);
    await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ proxyUrl: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(deps.config.proxyUrl).toBe("");
  });

  it("clears cookie jar", async () => {
    const deps = makeDeps();
    deps.cookieJar.set("gmail", ["sid=abc"]);
    const app = createApp(deps);
    await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(deps.cookieJar.size).toBe(0);
  });

  it("partial update keeps other fields", async () => {
    const deps = makeDeps();
    deps.config.platformApiUrl = "http://original:3000";
    deps.config.runToken = "orig-tok";
    const app = createApp(deps);
    await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(deps.config.runToken).toBe("new-tok");
    expect(deps.config.platformApiUrl).toBe("http://original:3000");
  });

  it("rejects without valid configSecret when set", async () => {
    const app = createApp(makeDeps({ configSecret: "secret-123" }));
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("accepts valid configSecret", async () => {
    const deps = makeDeps({ configSecret: "secret-123" });
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "new-tok" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-123",
      },
    });
    expect(res.status).toBe(200);
    expect(deps.config.runToken).toBe("new-tok");
  });

  it("rejects second configure call (one-time)", async () => {
    const app = createApp(makeDeps({ configSecret: "secret-123" }));
    const res1 = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "tok1" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-123",
      },
    });
    expect(res1.status).toBe(200);
    const res2 = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "tok2" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-123",
      },
    });
    expect(res2.status).toBe(403);
  });

  it("rejects when preConfigured is set (fresh sidecar)", async () => {
    const app = createApp(makeDeps({ preConfigured: true }));
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ runToken: "new-tok" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Already configured");
  });
});

describe("POST /configure — llm SSRF protection", () => {
  it("rejects llm config with blocked baseUrl", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({
        llm: { baseUrl: "http://169.254.169.254/metadata", apiKey: "key", placeholder: "ph" },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("blocked network range");
    expect(deps.config.llm).toBeUndefined();
  });

  it("allows llm config with null (clear)", async () => {
    const deps = makeDeps();
    deps.config.llm = { baseUrl: "https://api.openai.com", apiKey: "key", placeholder: "ph" };
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({ llm: null }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(deps.config.llm).toBeNull();
  });
});

describe("POST /configure — llm field", () => {
  it("updates llm config", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/configure", {
      method: "POST",
      body: JSON.stringify({
        runToken: "tok",
        llm: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-oai",
          placeholder: "sk-placeholder",
        },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(deps.config.llm).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-oai",
      placeholder: "sk-placeholder",
    });
  });
});
