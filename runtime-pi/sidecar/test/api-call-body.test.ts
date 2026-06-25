// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the buffered (non-multipart) body shapes of `{ns}__api_call`,
 * with a focus on the regression in issue #765: a `body` passed as a plain
 * JSON object was silently dropped — the upstream POST went out with an
 * empty body (`kind: "none"`) and no signal to the agent.
 *
 * These pin the corrected contract:
 *
 *   - JSON object body → serialized once to a JSON string AND sent with a
 *     default `Content-Type: application/json`.
 *   - A caller-supplied Content-Type is never overridden by the default.
 *   - A raw string body is forwarded verbatim with NO Content-Type guess.
 *   - `{{var}}` substitution still applies to an object body under
 *     `substituteBody: true` (the object is serialized first).
 *   - A present-but-unrecognized body (number/boolean) ERRORS at preflight
 *     instead of silently shipping an empty request.
 *   - A raw `{ fromFile }` that reached the sidecar unresolved ERRORS.
 *   - GET + body is still rejected at preflight (pre-existing guard).
 *   - The descriptor advertises the JSON-object shape.
 */

import { describe, it, expect, mock } from "bun:test";
import { createApp, buildSidecarRuntimeDeps, type AppDeps } from "../app.ts";
import { buildApiCallHost } from "./helpers/api-call-host.ts";
import type { CredentialsResponse } from "../helpers.ts";

const integrationCreds = (): CredentialsResponse => ({
  credentials: { access_token: "tok-abc" },
  authorizedUris: ["https://api.example.com/**"],
  allowAllUris: false,
  credentialHeaderName: "Authorization",
  credentialHeaderPrefix: "Bearer",
  credentialFieldName: "access_token",
});

function makeDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
    fetchCredentials: mock(async (): Promise<CredentialsResponse> => integrationCreds()),
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

async function makeApp(overrides?: Partial<AppDeps>) {
  const appDeps = makeDeps(overrides);
  const runtimeDeps = buildSidecarRuntimeDeps(appDeps);
  const host = await buildApiCallHost(
    [
      {
        namespace: "test",
        integrationId: "@appstrate/test",
        fetchCredentials: async () => integrationCreds(),
        refreshCredentials: async () => integrationCreds(),
      },
    ],
    runtimeDeps,
  );
  return createApp({
    ...appDeps,
    runtimeDeps,
    additionalMcpToolsProvider: () => host.buildTools(),
  });
}

async function rpc(
  app: ReturnType<typeof createApp>,
  body: { method: string; params?: unknown },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: "localhost",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  return { status: res.status, json: JSON.parse(await res.text()) };
}

/**
 * Build an app whose upstream fetch captures the request body bytes and
 * the Content-Type actually sent on the wire (read off `init`).
 */
function captureApp() {
  const captured: { body: string | null; contentType: string | null } = {
    body: null,
    contentType: null,
  };
  const fetchFn = mock(async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured.contentType = headers.get("content-type");
    const b = init?.body;
    if (typeof b === "string") {
      captured.body = b;
    } else if (b instanceof ArrayBuffer) {
      captured.body = new TextDecoder().decode(b);
    } else if (b instanceof Uint8Array) {
      captured.body = new TextDecoder().decode(b);
    } else if (b == null) {
      captured.body = null;
    } else {
      captured.body = "<non-buffered>";
    }
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { captured, fetchFn: fetchFn as unknown as typeof fetch };
}

describe("POST /mcp — api_call JSON-object body (issue #765)", () => {
  it("serializes a plain JSON object and defaults Content-Type: application/json", async () => {
    const { captured, fetchFn } = captureApp();
    const app = await makeApp({ fetchFn });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/scrape",
          method: "POST",
          body: { url: "https://example.com", formats: ["markdown"] },
        },
      },
    });

    const result = res.json.result as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    // The body actually reached the upstream — NOT dropped to kind:"none".
    expect(captured.body).not.toBeNull();
    expect(JSON.parse(captured.body!)).toEqual({
      url: "https://example.com",
      formats: ["markdown"],
    });
    expect(captured.contentType).toBe("application/json");
  });

  it("does not override a caller-supplied Content-Type", async () => {
    const { captured, fetchFn } = captureApp();
    const app = await makeApp({ fetchFn });

    await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/scrape",
          method: "POST",
          headers: { "Content-Type": "application/vnd.api+json" },
          body: { url: "https://example.com" },
        },
      },
    });

    // Caller's explicit choice wins; the JSON default must not clobber it.
    expect(captured.contentType).toBe("application/vnd.api+json");
    expect(JSON.parse(captured.body!)).toEqual({ url: "https://example.com" });
  });

  it("serializes a JSON array body", async () => {
    const { captured, fetchFn } = captureApp();
    const app = await makeApp({ fetchFn });

    await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/batch",
          method: "POST",
          body: [{ id: 1 }, { id: 2 }],
        },
      },
    });

    expect(JSON.parse(captured.body!)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(captured.contentType).toBe("application/json");
  });

  it("substitutes {{vars}} inside an object body when substituteBody: true", async () => {
    const { captured, fetchFn } = captureApp();
    const app = await makeApp({ fetchFn });

    await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/auth",
          method: "POST",
          substituteBody: true,
          body: { authorization: "Bearer {{access_token}}" },
        },
      },
    });

    expect(JSON.parse(captured.body!)).toEqual({ authorization: "Bearer tok-abc" });
  });
});

describe("POST /mcp — api_call string body Content-Type", () => {
  it("forwards a raw string body verbatim and adds NO Content-Type", async () => {
    const { captured, fetchFn } = captureApp();
    const app = await makeApp({ fetchFn });

    await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/ingest",
          method: "POST",
          body: "<xml>raw</xml>",
        },
      },
    });

    expect(captured.body).toBe("<xml>raw</xml>");
    // Deliberately not guessed — a string may be XML/form/NDJSON.
    expect(captured.contentType).toBeNull();
  });
});

describe("POST /mcp — api_call body silent-drop guard", () => {
  it("errors on a present-but-unrecognized body (number) instead of sending empty", async () => {
    const fetchFn = mock(async () => new Response("{}", { status: 200 }));
    const app = await makeApp({ fetchFn: fetchFn as unknown as typeof fetch });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/x",
          method: "POST",
          body: 42 as unknown as object,
        },
      },
    });

    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("unsupported shape");
    // Never contacted the upstream with an empty body.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("errors on a boolean body", async () => {
    const fetchFn = mock(async () => new Response("{}", { status: 200 }));
    const app = await makeApp({ fetchFn: fetchFn as unknown as typeof fetch });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/x",
          method: "POST",
          body: true as unknown as object,
        },
      },
    });

    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("unsupported shape");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("errors when a raw { fromFile } reaches the sidecar unresolved", async () => {
    const fetchFn = mock(async () => new Response("{}", { status: 200 }));
    const app = await makeApp({ fetchFn: fetchFn as unknown as typeof fetch });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/x",
          method: "POST",
          body: { fromFile: "data.json" },
        },
      },
    });

    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("fromFile was not resolved");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("still rejects a body on GET (pre-existing preflight)", async () => {
    const fetchFn = mock(async () => new Response("{}", { status: 200 }));
    const app = await makeApp({ fetchFn: fetchFn as unknown as typeof fetch });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/x",
          method: "GET",
          body: { url: "https://example.com" },
        },
      },
    });

    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not allowed with method 'GET'");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("POST /mcp — api_call descriptor advertises JSON-object body", () => {
  it("lists a JSON-object variant and documents Content-Type defaulting", async () => {
    const app = await makeApp();
    const res = await rpc(app, { method: "tools/list" });
    const result = res.json.result as {
      tools: Array<{
        name: string;
        inputSchema: { properties: { body?: { oneOf?: unknown[]; description?: string } } };
      }>;
    };
    const proxy = result.tools.find((t) => t.name === "test__api_call")!;
    expect(proxy.inputSchema.properties.body?.oneOf?.length).toBe(5);
    expect(proxy.inputSchema.properties.body?.description).toContain("application/json");
  });
});
