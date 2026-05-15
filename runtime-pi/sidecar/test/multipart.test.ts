// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the `{ multipart: [...] }` body shape of `provider_call`.
 *
 * The MCP handler validates parts via the structured Zod-like guard in
 * `mcp.ts`, builds a standard `FormData` (so Bun's `fetch()` controls
 * the `Content-Type: multipart/form-data; boundary=…` header), strips
 * any caller-supplied `Content-Type: multipart/...` header, and lets
 * `executeProviderCall` regenerate the body per attempt for the
 * 401-retry path. These tests pin the wire-format guarantees:
 *
 *   - Upstream sees `multipart/form-data` with a well-formed boundary.
 *   - All parts round-trip via `Request#formData()`.
 *   - Binary file parts match byte-for-byte.
 *   - `{{var}}` substitution applies to string field parts only when
 *     `substituteBody: true`, never to binary part bytes.
 *   - 413 + structured PAYLOAD_TOO_LARGE error when the sum of decoded
 *     file bytes exceeds SIDECAR_MAX_REQUEST_BODY_BYTES.
 *   - `tools/list` advertises the multipart shape.
 */

import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import { MAX_REQUEST_BODY_SIZE } from "../helpers.ts";
import type { CredentialsResponse } from "../helpers.ts";

function makeMultipartDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
    fetchCredentials: mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "tok-abc" },
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
    ),
    isReady: () => true,
    ...overrides,
  };
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

describe("POST /mcp — provider_call multipart/form-data", () => {
  it("builds a FormData and lets fetch() pick a multipart Content-Type with boundary", async () => {
    let capturedContentType: string | null = null;
    const capturedFields: Record<string, string> = {};
    let capturedFile: { name: string; size: number; bytes: Uint8Array; type: string } | null = null;

    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      // Parse the multipart body upstream-side. Constructing a Request
      // around the same body lets us call `.formData()` and verify the
      // boundary token in the Content-Type matches the wire bytes.
      // When the body is a FormData, fetch() synthesises the
      // Content-Type header on the Request itself rather than mutating
      // `init.headers` — so we read it from the Request after
      // construction.
      const req = new Request("https://api.example.com/sink", {
        method: "POST",
        headers: new Headers(init?.headers as HeadersInit | undefined),
        body: init?.body as BodyInit,
      });
      capturedContentType = req.headers.get("content-type");
      const fd = await req.formData();
      for (const [k, v] of fd.entries()) {
        if (typeof v === "string") {
          capturedFields[k] = v;
        } else {
          const ab = await v.arrayBuffer();
          capturedFile = {
            name: k,
            size: ab.byteLength,
            bytes: new Uint8Array(ab),
            type: v.type,
          };
        }
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const app = createApp(makeMultipartDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    // A non-UTF-8 payload — the canary for "body was JSON-stringified
    // instead of multipart-encoded".
    const fileBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const base64 = Buffer.from(fileBytes).toString("base64");

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          body: {
            multipart: [
              { name: "title", value: "hello world" },
              { name: "tag", value: "alpha" },
              {
                name: "image",
                filename: "logo.png",
                bytes: base64,
                encoding: "base64",
                contentType: "image/png",
              },
            ],
          },
        },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { isError?: boolean };
    expect(result.isError).toBeFalsy();

    expect(capturedContentType).not.toBeNull();
    expect(capturedContentType!).toMatch(/^multipart\/form-data;\s*boundary=/i);
    expect(capturedFields).toEqual({ title: "hello world", tag: "alpha" });
    expect(capturedFile).not.toBeNull();
    expect(capturedFile!.name).toBe("image");
    expect(capturedFile!.type).toBe("image/png");
    expect(capturedFile!.size).toBe(fileBytes.byteLength);
    expect(capturedFile!.bytes).toEqual(fileBytes);
  });

  it("substitutes {{vars}} in string field parts when substituteBody: true (never in file bytes)", async () => {
    const capturedFields: Record<string, string> = {};
    let capturedFileBytes: Uint8Array | null = null;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      const reqHeaders = new Headers(init?.headers as HeadersInit | undefined);
      const req = new Request("https://api.example.com/sink", {
        method: "POST",
        headers: reqHeaders,
        body: init?.body as BodyInit,
      });
      const fd = await req.formData();
      for (const [k, v] of fd.entries()) {
        if (typeof v === "string") {
          capturedFields[k] = v;
        } else {
          capturedFileBytes = new Uint8Array(await v.arrayBuffer());
        }
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const app = createApp(makeMultipartDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    // The literal `{{access_token}}` placeholder inside the binary
    // payload must NOT be substituted — that would corrupt the file
    // content and silently leak a credential into a binary upload.
    const bytesWithPlaceholder = new TextEncoder().encode("BINARY:{{access_token}}:END");
    const base64 = Buffer.from(bytesWithPlaceholder).toString("base64");

    await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          substituteBody: true,
          body: {
            multipart: [
              { name: "token", value: "Bearer {{access_token}}" },
              { name: "untouched", value: "no-placeholder" },
              {
                name: "blob",
                filename: "data.bin",
                bytes: base64,
                encoding: "base64",
                contentType: "application/octet-stream",
              },
            ],
          },
        },
      },
    });

    expect(capturedFields.token).toBe("Bearer tok-abc");
    expect(capturedFields.untouched).toBe("no-placeholder");
    expect(capturedFileBytes).not.toBeNull();
    // Binary part must come through verbatim — placeholder text intact.
    expect(new TextDecoder().decode(capturedFileBytes!)).toBe("BINARY:{{access_token}}:END");
  });

  it("does NOT substitute field-part values when substituteBody is omitted", async () => {
    const capturedFields: Record<string, string> = {};
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      const req = new Request("https://api.example.com/sink", {
        method: "POST",
        headers: new Headers(init?.headers as HeadersInit | undefined),
        body: init?.body as BodyInit,
      });
      const fd = await req.formData();
      for (const [k, v] of fd.entries()) {
        if (typeof v === "string") capturedFields[k] = v;
      }
      return new Response("{}", { status: 200 });
    });
    const app = createApp(makeMultipartDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          body: {
            multipart: [{ name: "token", value: "Bearer {{access_token}}" }],
          },
        },
      },
    });
    // Off by default — placeholder must reach upstream untouched.
    expect(capturedFields.token).toBe("Bearer {{access_token}}");
  });

  it("strips caller-supplied Content-Type: multipart/... so fetch() controls the boundary", async () => {
    let capturedContentType: string | null = null;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      // Re-derive Content-Type via a Request so we observe what
      // fetch() actually puts on the wire (FormData triggers the
      // boundary to be set on the Request, not on init.headers).
      const req = new Request("https://api.example.com/sink", {
        method: "POST",
        headers: new Headers(init?.headers as HeadersInit | undefined),
        body: init?.body as BodyInit,
      });
      capturedContentType = req.headers.get("content-type");
      return new Response("{}", { status: 200 });
    });
    const app = createApp(makeMultipartDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          headers: {
            // Stale boundary token — if the sidecar forwards this
            // header verbatim, Bun emits a body with a different
            // boundary and the upstream parser breaks. The sidecar
            // must drop this so fetch() picks its own.
            "Content-Type": "multipart/form-data; boundary=AAAAAA",
          },
          body: {
            multipart: [{ name: "f", value: "v" }],
          },
        },
      },
    });
    expect(capturedContentType).not.toBeNull();
    expect(capturedContentType!).toMatch(/^multipart\/form-data;\s*boundary=/i);
    expect(capturedContentType!.includes("AAAAAA")).toBe(false);
  });

  it("does NOT strip caller-supplied non-multipart Content-Type headers", async () => {
    // The strip filter must be scoped to `multipart/*` — a caller that
    // accidentally sets `Content-Type: application/json` alongside a
    // multipart body should still have that header pass through (the
    // FormData body will then override it on the Request, but the
    // filter regex must not match).
    let capturedContentType: string | null = null;
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      // Read directly off the init.headers map — this lets us observe
      // whether the sidecar's strip filter touched it, independent of
      // whatever fetch() does at Request construction time.
      const rawHeaders = init?.headers as Record<string, string> | undefined;
      capturedContentType = rawHeaders?.["Content-Type"] ?? rawHeaders?.["content-type"] ?? null;
      return new Response("{}", { status: 200 });
    });
    const app = createApp(makeMultipartDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: { multipart: [{ name: "f", value: "v" }] },
        },
      },
    });
    // Non-multipart Content-Type survived the strip filter.
    expect(capturedContentType).not.toBeNull();
    expect(capturedContentType!).toBe("application/json");
  });

  it("fail-closes on unresolved {{placeholders}} in field-part values under substituteBody", async () => {
    // Mirror of the buffered text path: a typo in a `{{var}}` template
    // (`access_tokn` vs `access_token`) must surface as a 400-style
    // preflight error rather than silently shipping the literal
    // `{{access_tokn}}` to the upstream third party.
    const fetchFn = mock(async () => new Response("{}", { status: 200 }));
    const app = createApp(makeMultipartDeps({ fetchFn: fetchFn as unknown as typeof fetch }));

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          substituteBody: true,
          body: {
            multipart: [{ name: "token", value: "Bearer {{access_tokn}}" }],
          },
        },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unresolved placeholders in body");
    expect(result.content[0]!.text).toContain("access_tokn");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a non-array body.multipart with a clear runtime guard", async () => {
    // The MCP SDK does NOT validate tools/call arguments against the
    // descriptor's inputSchema, so a caller can pass `multipart: "x"`.
    // The handler must reject it with a structured error instead of
    // iterating a string char-by-char.
    const app = createApp(makeMultipartDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          body: { multipart: "oops" as unknown as object[] },
        },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("must be an array");
  });

  it("rejects body.multipart with more than MAX_MULTIPART_PARTS entries", async () => {
    // Without this cap, a caller could supply 100k single-byte parts
    // that fit every other check (envelope cap, decoded-bytes cap) but
    // allocate 100k Blobs + FormData entries.
    const tooMany = Array.from({ length: 257 }, (_, i) => ({ name: `f${i}`, value: "v" }));
    const app = createApp(makeMultipartDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          body: { multipart: tooMany },
        },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("exceeds the per-request limit of 256");
  });

  it("rejects a part with an oversize filename", async () => {
    const app = createApp(makeMultipartDeps());
    const huge = "x".repeat(1025);
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          body: {
            multipart: [
              {
                name: "f",
                filename: huge,
                bytes: Buffer.from("x").toString("base64"),
                encoding: "base64",
              },
            ],
          },
        },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("filename length");
  });

  it("returns 413 with structured PAYLOAD_TOO_LARGE when summed file bytes exceed the cap", async () => {
    // Two parts that together overflow MAX_REQUEST_BODY_SIZE even
    // though each individually fits — verifies the cap is the SUM, not
    // the per-part max.
    const half = Buffer.alloc(Math.ceil(MAX_REQUEST_BODY_SIZE / 2) + 1024, 0x41);
    const b64 = half.toString("base64");
    const app = createApp(makeMultipartDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          body: {
            multipart: [
              { name: "a", filename: "a.bin", bytes: b64, encoding: "base64" },
              { name: "b", filename: "b.bin", bytes: b64, encoding: "base64" },
            ],
          },
        },
      },
    });
    const result = res.json.result as {
      content: Array<{ text: string }>;
      structuredContent?: {
        error?: { code?: string; scope?: string; limit?: number; envVar?: string };
      };
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("exceeds the per-request limit");
    expect(result.structuredContent?.error?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(result.structuredContent?.error?.scope).toBe("request_body");
    expect(result.structuredContent?.error?.limit).toBe(MAX_REQUEST_BODY_SIZE);
    expect(result.structuredContent?.error?.envVar).toBe("SIDECAR_MAX_REQUEST_BODY_BYTES");
  });

  it("rejects a file part with invalid base64", async () => {
    const app = createApp(makeMultipartDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          body: {
            multipart: [
              { name: "f", filename: "f.bin", bytes: "not-base64!!!", encoding: "base64" },
            ],
          },
        },
      },
    });
    const result = res.json.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not standard base64");
  });

  it("advertises the multipart shape in tools/list", async () => {
    const app = createApp(makeMultipartDeps());
    const res = await rpc(app, { method: "tools/list" });
    const result = res.json.result as {
      tools: Array<{
        name: string;
        inputSchema: { properties: { body?: { oneOf?: unknown[]; description?: string } } };
      }>;
    };
    const proxy = result.tools.find((t) => t.name === "provider_call")!;
    expect(proxy.inputSchema.properties.body?.oneOf?.length).toBe(3);
    expect(proxy.inputSchema.properties.body?.description).toContain("multipart");
  });

  it("dispatches a multipart JSON-RPC call without crashing the MCP transport", async () => {
    // Lightweight smoke-test: tool call returns 200 + non-error result,
    // confirming the descriptor + handler are wired end-to-end through
    // the SDK's stateless transport.
    const app = createApp(makeMultipartDeps());
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "@appstrate/test",
          target: "https://api.example.com/sink",
          method: "POST",
          body: { multipart: [{ name: "k", value: "v" }] },
        },
      },
    });
    expect(res.status).toBe(200);
    const result = res.json.result as { isError?: boolean };
    expect(result.isError).toBeFalsy();
  });
});
