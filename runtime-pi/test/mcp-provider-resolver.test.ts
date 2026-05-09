// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the MCP-backed `ProviderResolver` used by container
 * mode. The resolver is the bridge between AFPS's runner-pi factory
 * (the canonical Pi-tool surface for `provider_call`) and the
 * sidecar's MCP `provider_call` tool — every body shape supported by
 * AFPS (`string` / `{ fromFile }` / `{ fromBytes }` / `{ multipart }`)
 * must transit safely.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInProcessPair,
  wrapClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import type { Bundle, PackageIdentity } from "@appstrate/afps-runtime/bundle";
import { McpProviderResolver } from "../mcp/provider-resolver.ts";

function makeBundle(): Bundle {
  const identity = "@test/agent@0.0.0" as PackageIdentity;
  return {
    bundleFormatVersion: "1.0",
    root: identity,
    packages: new Map([
      [
        identity,
        {
          identity,
          manifest: {
            name: "@test/agent",
            version: "0.0.0",
            type: "agent",
            dependencies: { providers: { "@test/echo": "^1.0.0" } },
          },
          files: new Map(),
          integrity: "" as never,
        },
      ],
    ]),
    integrity: "" as never,
  } as Bundle;
}

interface Captured {
  arguments?: Record<string, unknown>;
}

async function makeServer(opts: {
  responseBlock?: { type: "text"; text: string };
  isError?: boolean;
  /**
   * Optional `_meta` payload to surface alongside the result. Set this
   * to test the resolver's upstream-meta consumption path
   * (`{ "appstrate/upstream": { status, headers } }`). Tests that omit
   * this assert the legacy fallback (synthesised 200 / `{}`).
   */
  meta?: Record<string, unknown>;
}) {
  const captured: Captured = {};
  const tool: AppstrateToolDefinition = {
    descriptor: {
      name: "provider_call",
      description: "mock",
      inputSchema: { type: "object" },
    },
    handler: (async (args: Record<string, unknown>) => {
      captured.arguments = args;
      const block = opts.responseBlock ?? { type: "text", text: '{"ok":true}' };
      return {
        content: [block],
        ...(opts.isError ? { isError: true } : {}),
        ...(opts.meta ? { _meta: opts.meta } : {}),
      };
    }) as never,
  };
  const pair = await createInProcessPair([tool]);
  const mcp = wrapClient(pair.client, { close: () => Promise.resolve() });
  return { pair, mcp, captured };
}

const ctxBase = (workspace: string) => ({
  runId: "run_test",
  toolCallId: "tc_1",
  workspace,
  signal: new AbortController().signal,
  emit: () => {},
});

/**
 * One multipart part as it appears on the wire — headers and body
 * separated. We can't use `Response.formData()` to verify per-part
 * `Content-Type` because Bun's parser drops it whenever the part lacks a
 * (non-empty) `filename` — and FormData always emits `filename=""` for
 * Blob-wrapped text parts, which is exactly the Drive metadata case.
 */
interface ParsedPart {
  name: string;
  filename?: string;
  contentType?: string;
  body: string;
}

/**
 * Parse the captured `provider_call` multipart body back into structured
 * parts. The MCP transport receives the body as base64'd bytes plus a
 * `Content-Type: multipart/form-data; boundary=…` header; we extract the
 * boundary from the header, split on it, and walk each chunk's headers
 * once. Header values are matched case-insensitively so the assertions
 * do not encode runtime-specific casing (Bun lowercases `charset=utf-8`,
 * other runtimes preserve the caller's casing).
 */
function parseMultipartCapture(captured: Captured): ParsedPart[] {
  const arg = captured.arguments as {
    headers?: Record<string, string>;
    body?: { fromBytes: string; encoding: string };
  };
  const ct = arg.headers?.["Content-Type"];
  if (!ct) throw new Error("captured arguments missing Content-Type header");
  const boundaryMatch = ct.match(/boundary=([^;]+)/);
  if (!boundaryMatch) throw new Error(`could not extract boundary from "${ct}"`);
  const boundary = `--${boundaryMatch[1]!.trim()}`;
  const wire = Buffer.from(arg.body!.fromBytes, "base64").toString("utf-8");
  const parts: ParsedPart[] = [];
  for (const chunk of wire.split(boundary)) {
    const trimmed = chunk.replace(/^\r\n/, "").replace(/\r\n$/, "");
    if (!trimmed || trimmed === "--" || trimmed === "--\r\n") continue;
    const sep = trimmed.indexOf("\r\n\r\n");
    if (sep < 0) continue;
    const rawHeaders = trimmed.slice(0, sep);
    const body = trimmed.slice(sep + 4);
    const headers = new Map<string, string>();
    for (const line of rawHeaders.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const cd = headers.get("content-disposition") ?? "";
    const name = cd.match(/name="([^"]*)"/)?.[1];
    if (!name) continue;
    const filenameMatch = cd.match(/filename="([^"]*)"/);
    parts.push({
      name,
      filename: filenameMatch ? filenameMatch[1] : undefined,
      contentType: headers.get("content-type"),
      body,
    });
  }
  return parts;
}

describe("McpProviderResolver — body forwarding", () => {
  it("forwards a string body verbatim over MCP", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/items",
          body: '{"x":1}',
          headers: { "Content-Type": "application/json" },
        },
        ctxBase(workspace),
      );
      expect(captured.arguments).toMatchObject({
        providerId: "@test/echo",
        method: "POST",
        target: "https://api.example.com/items",
        body: '{"x":1}',
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      await pair.close();
    }
  });

  it("resolves { fromFile } against the workspace and ships bytes as base64", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );

      // Non-UTF-8 binary blob — this is the case the legacy mcp-direct
      // path corrupted (string-only body schema → TextEncoder
      // round-trip → mojibake).
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
      writeFileSync(join(workspace, "image.jpg"), bytes);

      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/upload",
          body: { fromFile: "image.jpg" },
        },
        ctxBase(workspace),
      );

      const arg = captured.arguments as { body?: { fromBytes: string; encoding: string } };
      expect(arg.body).toBeDefined();
      expect(arg.body!.encoding).toBe("base64");
      const decoded = Buffer.from(arg.body!.fromBytes, "base64");
      expect(new Uint8Array(decoded)).toEqual(bytes);
    } finally {
      await pair.close();
    }
  });

  it("forwards { fromBytes } directly without re-encoding", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const inputBytes = new Uint8Array([0xff, 0x01, 0x02, 0x03]);
      const inputBase64 = Buffer.from(inputBytes).toString("base64");

      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/upload",
          body: { fromBytes: inputBase64, encoding: "base64" },
        },
        ctxBase(workspace),
      );

      const arg = captured.arguments as { body?: { fromBytes: string; encoding: string } };
      expect(arg.body!.encoding).toBe("base64");
      expect(Buffer.from(arg.body!.fromBytes, "base64")).toEqual(Buffer.from(inputBytes));
    } finally {
      await pair.close();
    }
  });

  it("resolves { multipart } and surfaces the multipart Content-Type", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      writeFileSync(join(workspace, "doc.txt"), "the body");

      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/upload",
          body: {
            multipart: [
              { name: "title", value: "demo" },
              { name: "file", fromFile: "doc.txt" },
            ],
          },
        },
        ctxBase(workspace),
      );

      const arg = captured.arguments as {
        headers?: Record<string, string>;
        body?: { fromBytes: string; encoding: string };
      };
      expect(arg.headers!["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
      expect(arg.body!.encoding).toBe("base64");
      const decoded = Buffer.from(arg.body!.fromBytes, "base64").toString("utf-8");
      expect(decoded).toContain('name="title"');
      expect(decoded).toContain("demo");
      expect(decoded).toContain('name="file"; filename="doc.txt"');
      expect(decoded).toContain("the body");
    } finally {
      await pair.close();
    }
  });

  it("emits explicit Content-Type on a multipart text part (Drive metadata pattern)", async () => {
    // Drive multipart upload requires the metadata part to carry
    // `Content-Type: application/json`. The text part schema accepts an
    // optional `contentType` so callers do not have to base64-encode the
    // JSON via `fromBytes` just to set the part header. We assert via the
    // platform's standard multipart parser (`Response.formData()`) rather
    // than regex so the test does not encode FormData's serialization
    // quirks (whitespace, charset case, stub `filename=""` on Blobs…).
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      writeFileSync(join(workspace, "out.xlsx"), "binary-bytes");

      await tool!.execute(
        {
          method: "POST",
          target: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
          body: {
            multipart: [
              {
                name: "metadata",
                value: '{"name":"file.xlsx"}',
                contentType: "application/json; charset=UTF-8",
              },
              {
                name: "media",
                fromFile: "out.xlsx",
                contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              },
            ],
          },
        },
        ctxBase(workspace),
      );

      const parts = parseMultipartCapture(captured);
      const metadata = parts.find((p) => p.name === "metadata");
      const media = parts.find((p) => p.name === "media");
      expect(metadata).toBeDefined();
      expect(media).toBeDefined();

      // Drive needs the JSON content-type on metadata. We compare on the
      // lowercased media-type + parameters tuple so the assertion does not
      // depend on the runtime's preferred casing of `charset=utf-8`.
      expect(metadata!.contentType?.toLowerCase()).toBe("application/json; charset=utf-8");
      expect(metadata!.body).toBe('{"name":"file.xlsx"}');
      expect(media!.contentType).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(media!.filename).toBe("out.xlsx");
      expect(media!.body).toBe("binary-bytes");
    } finally {
      await pair.close();
    }
  });

  it("omits Content-Type on a multipart text part when contentType is not set", async () => {
    // Backwards-compat: existing callers that pass `{ name, value }` without
    // contentType continue to get FormData's plain-string serialization
    // (no explicit `Content-Type` part header — server defaults to
    // `text/plain`). The parser surfaces the value as a string, not a Blob.
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));

      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/x",
          body: { multipart: [{ name: "field", value: "plain" }] },
        },
        ctxBase(workspace),
      );

      const parts = parseMultipartCapture(captured);
      const field = parts.find((p) => p.name === "field");
      expect(field).toBeDefined();
      expect(field!.contentType).toBeUndefined();
      expect(field!.body).toBe("plain");
    } finally {
      await pair.close();
    }
  });

  // Regression: the agent-side resolver must propagate `substituteBody`
  // into the MCP `provider_call` arguments. Without this, the sidecar
  // never sees the opt-in flag and forwards `{{credential}}` placeholders
  // to upstream verbatim, breaking every transparent username/password
  // login flow documented in PROVIDER.md (Saneki, Amisgest, OrgaBusiness…).
  it("forwards substituteBody=true into the MCP arguments", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/login",
          body: '{"login":"{{email}}","password":"{{password}}"}',
          substituteBody: true,
        },
        ctxBase(workspace),
      );
      expect(captured.arguments?.substituteBody).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it("omits substituteBody when not set (default off)", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/x",
          body: "no-op",
        },
        ctxBase(workspace),
      );
      // Absent rather than `false` — the sidecar defaults to off, so we
      // keep the wire payload minimal when the agent did not opt in.
      expect(captured.arguments).not.toHaveProperty("substituteBody");
    } finally {
      await pair.close();
    }
  });

  it("omits substituteBody when explicitly false (no wire noise)", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      await tool!.execute(
        {
          method: "POST",
          target: "https://api.example.com/x",
          body: "no-op",
          substituteBody: false,
        },
        ctxBase(workspace),
      );
      expect(captured.arguments).not.toHaveProperty("substituteBody");
    } finally {
      await pair.close();
    }
  });

  it("rejects { fromFile } resolving outside the workspace (path traversal)", async () => {
    const { pair, mcp, captured } = await makeServer({});
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));

      let threw = false;
      try {
        await tool!.execute(
          {
            method: "POST",
            target: "https://api.example.com/upload",
            body: { fromFile: "../../../etc/passwd" },
          },
          ctxBase(workspace),
        );
      } catch {
        threw = true;
      }
      // The contract is: must NOT have made the upstream call.
      expect(captured.arguments).toBeUndefined();
      // AFPS's resolveSafePath throws for paths that escape the
      // workspace — either way the call is gated client-side.
      expect(threw).toBe(true);
    } finally {
      await pair.close();
    }
  });
});

describe("McpProviderResolver — response handling", () => {
  it("maps an MCP text block to a text-kind ProviderCallResponse", async () => {
    const { pair, mcp } = await makeServer({
      responseBlock: { type: "text", text: '{"hello":"world"}' },
    });
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const result = await tool!.execute(
        { method: "GET", target: "https://api.example.com/items" },
        ctxBase(workspace),
      );
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.status).toBe(200);
      expect(parsed.body.kind).toBe("text");
      expect(parsed.body.text).toBe('{"hello":"world"}');
    } finally {
      await pair.close();
    }
  });

  it("surfaces a 502 with the MCP isError text concatenated", async () => {
    const { pair, mcp } = await makeServer({
      responseBlock: { type: "text", text: "provider_call: upstream rate-limited" },
      isError: true,
    });
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const result = await tool!.execute(
        { method: "GET", target: "https://api.example.com/items" },
        ctxBase(workspace),
      );
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.status).toBe(502);
      expect(parsed.body.kind).toBe("text");
      expect(parsed.body.text).toContain("upstream rate-limited");
    } finally {
      await pair.close();
    }
  });
});

describe("McpProviderResolver — upstream meta propagation", () => {
  it("uses real upstream status + headers when sidecar ships _meta", async () => {
    const { pair, mcp } = await makeServer({
      responseBlock: { type: "text", text: "" },
      meta: {
        "appstrate/upstream": {
          status: 308,
          headers: {
            location: "https://api.example.com/upload/session-xyz",
            "content-range": "bytes 0-4194303/8388608",
          },
        },
      },
    });
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const result = await tool!.execute(
        { method: "POST", target: "https://api.example.com/upload" },
        ctxBase(workspace),
      );
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      // 308 is the Google resumable mid-upload signal — must surface
      // verbatim, not be synthesised to 200.
      expect(parsed.status).toBe(308);
      expect(parsed.headers.location).toBe("https://api.example.com/upload/session-xyz");
      expect(parsed.headers["content-range"]).toBe("bytes 0-4194303/8388608");
    } finally {
      await pair.close();
    }
  });

  it("falls back to legacy 200 / {} when sidecar does not ship _meta", async () => {
    // Backwards-compatibility regression: an old sidecar that hasn't
    // rolled the propagation change still produces a usable response.
    const { pair, mcp } = await makeServer({
      responseBlock: { type: "text", text: '{"ok":true}' },
      // no meta
    });
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const result = await tool!.execute(
        { method: "GET", target: "https://api.example.com/items" },
        ctxBase(workspace),
      );
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.status).toBe(200);
      // Headers carry the synthesised content-type only.
      expect(parsed.body.kind).toBe("text");
    } finally {
      await pair.close();
    }
  });

  it("surfaces upstream 4xx status (and Retry-After) on tool-level errors", async () => {
    // Pre-meta behaviour returned 502 for every tool-level error; with
    // meta we surface the real upstream code so the agent can react
    // appropriately (Retry-After, rate limit, auth refresh).
    const { pair, mcp } = await makeServer({
      responseBlock: { type: "text", text: "rate limited" },
      isError: true,
      meta: {
        "appstrate/upstream": {
          status: 429,
          headers: { "retry-after": "60" },
        },
      },
    });
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const result = await tool!.execute(
        { method: "POST", target: "https://api.example.com/items" },
        ctxBase(workspace),
      );
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.status).toBe(429);
      expect(parsed.headers["retry-after"]).toBe("60");
    } finally {
      await pair.close();
    }
  });

  it("ignores malformed _meta payloads (defence-in-depth)", async () => {
    // A misbehaving sidecar shipping a non-object or a non-integer
    // status must not crash the agent; the legacy fallback applies.
    const { pair, mcp } = await makeServer({
      responseBlock: { type: "text", text: '{"ok":true}' },
      meta: {
        "appstrate/upstream": "not-an-object",
      },
    });
    try {
      const resolver = new McpProviderResolver(mcp);
      const [tool] = await resolver.resolve(
        [{ name: "@test/echo", version: "^1.0.0" }],
        makeBundle(),
      );
      const workspace = mkdtempSync(join(tmpdir(), "mcp-resolver-"));
      const result = await tool!.execute(
        { method: "GET", target: "https://api.example.com/items" },
        ctxBase(workspace),
      );
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      // Falls back to 200, no crash.
      expect(parsed.status).toBe(200);
    } finally {
      await pair.close();
    }
  });
});
