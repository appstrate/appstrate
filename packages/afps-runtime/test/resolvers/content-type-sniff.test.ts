// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Tests for file-type content sniffing (Task 2 — Phase 5.2).
 *
 * When upstream returns `application/octet-stream` or no Content-Type,
 * serializeFetchResponse sniffs the magic bytes and sets a more specific
 * mimeType, flagging the result with mimeTypeSniffed: true.
 *
 * Declared text/* and specific mime types are NOT overridden.
 * Sniffing only runs on the buffered path (inline / toFile). The
 * streaming path (ctx.streaming + toFile) is excluded — TODO for a
 * future PR.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
  type Bundle,
  type BundlePackage,
  type PackageIdentity,
} from "../../src/bundle/index.ts";
import {
  SidecarProviderResolver,
  type ProviderCallResponseBody,
  type RunEvent,
  type ToolContext,
} from "../../src/resolvers/index.ts";
import { serializeFetchResponse } from "../../src/resolvers/provider-tool.ts";

// ─── PNG / PDF magic bytes ─────────────────────────────────────────────────

/** Minimal PNG: starts with the 8-byte PNG signature. */
function pngBytes(): Uint8Array {
  // PNG signature + minimal IHDR + IDAT + IEND (1x1 transparent)
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a, // PNG signature
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52, // IHDR length + type
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01, // 1x1
    0x08,
    0x06,
    0x00,
    0x00,
    0x00,
    0x1f,
    0x15,
    0xc4,
    0x89,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x44,
    0x41, // IDAT
    0x54,
    0x78,
    0x9c,
    0x63,
    0x00,
    0x01,
    0x00,
    0x00,
    0x05,
    0x00,
    0x01,
    0x0d,
    0x0a,
    0x2d,
    0xb4,
    0x00,
    0x00,
    0x00,
    0x00,
    0x49,
    0x45,
    0x4e,
    0x44,
    0xae, // IEND
    0x42,
    0x60,
    0x82,
  ]);
}

/** Minimal PDF header + binary bytes. */
function pdfBytes(): Uint8Array {
  const header = new TextEncoder().encode("%PDF-1.4\n%\xff\xfe\n");
  const body = new TextEncoder().encode("1 0 obj<</Type /Catalog>>endobj\n%%EOF\n");
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(header, 0);
  out.set(body, header.byteLength);
  return out;
}

/** Plain ASCII text — no magic bytes. */
function textBytes(): Uint8Array {
  return new TextEncoder().encode("hello world, this is plain text");
}

/** Only 1 byte — too short for file-type to sniff. */
function tinyBytes(): Uint8Array {
  return new Uint8Array([0x01]);
}

// ─── Bundle / resolver helpers (mirrors binary-roundtrip.test.ts) ──────────

const enc = new TextEncoder();

function makePackage(
  name: `@${string}/${string}`,
  version: string,
  type: "agent" | "provider",
  files: Record<string, string>,
  extraManifest: Record<string, unknown> = {},
): BundlePackage {
  const identity = `${name}@${version}` as PackageIdentity;
  const manifest = { name, version, type, ...extraManifest };
  const filesMap = new Map<string, Uint8Array>();
  filesMap.set("manifest.json", enc.encode(JSON.stringify(manifest)));
  for (const [k, v] of Object.entries(files)) filesMap.set(k, enc.encode(v));
  const integrity = recordIntegrity(serializeRecord(computeRecordEntries(filesMap)));
  return { identity, manifest, files: filesMap, integrity };
}

function makeBundle(root: BundlePackage, deps: BundlePackage[] = []): Bundle {
  const packages = new Map<PackageIdentity, BundlePackage>();
  packages.set(root.identity, root);
  for (const d of deps) packages.set(d.identity, d);
  const pkgIndex = new Map<PackageIdentity, { path: string; integrity: string }>();
  for (const p of packages.values()) {
    pkgIndex.set(p.identity, {
      path: `packages/${(p.manifest as { name: string }).name}/${(p.manifest as { version: string }).version}/`,
      integrity: p.integrity,
    });
  }
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: root.identity,
    packages,
    integrity: bundleIntegrity(pkgIndex),
  };
}

function makeCtx(workspace: string, toolCallId = "tc_sniff"): ToolContext {
  return {
    workspace,
    toolCallId,
    runId: "run_test",
    signal: new AbortController().signal,
    emit: (_e: RunEvent) => {},
  };
}

function buildResolver(responder: (req: { url: string; init: RequestInit }) => Promise<Response>): {
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
} {
  const root = makePackage("@acme/agent", "1.0.0", "agent", {});
  const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
    "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
  });
  const bundle = makeBundle(root, [providerPkg]);

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    return responder({ url: String(url), init: init ?? {} });
  }) as typeof fetch;

  const resolver = new SidecarProviderResolver({
    sidecarUrl: "http://sidecar:8080",
    fetch: fetchImpl,
  });

  let executor: ((args: unknown, ctx: ToolContext) => Promise<unknown>) | undefined;
  const ready = (async () => {
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], bundle);
    executor = tools[0]!.execute;
  })();

  return {
    async execute(params, ctx) {
      await ready;
      return executor!(params, ctx);
    },
  };
}

function parseBody(result: unknown): {
  status: number;
  headers: Record<string, string>;
  body: ProviderCallResponseBody;
} {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0]!.text);
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("content-type sniffing", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "afps-sniff-"));
  });

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  it("octet-stream + PNG magic bytes → mime becomes image/png, mimeTypeSniffed: true", async () => {
    const bytes = pngBytes();
    const { execute } = buildResolver(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const res = await execute(
      { method: "GET", target: "https://api.example.com/img" },
      makeCtx(workspace, "tc_sniff_png"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("inline");
    if (parsed.body.kind !== "inline") throw new Error("unreachable");
    expect(parsed.body.mimeType).toBe("image/png");
    expect(parsed.body.mimeTypeSniffed).toBe(true);
  });

  it("octet-stream + PDF magic bytes → mime becomes application/pdf, mimeTypeSniffed: true", async () => {
    const bytes = pdfBytes();
    const { execute } = buildResolver(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const res = await execute(
      { method: "GET", target: "https://api.example.com/doc" },
      makeCtx(workspace, "tc_sniff_pdf"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("inline");
    if (parsed.body.kind !== "inline") throw new Error("unreachable");
    expect(parsed.body.mimeType).toBe("application/pdf");
    expect(parsed.body.mimeTypeSniffed).toBe(true);
  });

  it("octet-stream + plain text bytes → mime stays application/octet-stream, no sniff flag", async () => {
    const bytes = textBytes();
    const { execute } = buildResolver(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const res = await execute(
      { method: "GET", target: "https://api.example.com/data" },
      makeCtx(workspace, "tc_sniff_text_as_octet"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("inline");
    if (parsed.body.kind !== "inline") throw new Error("unreachable");
    expect(parsed.body.mimeType).toBe("application/octet-stream");
    expect(parsed.body.mimeTypeSniffed).toBeUndefined();
  });

  it("declared image/png + JPEG bytes → mime stays image/png (no override of specific declared type)", async () => {
    // JPEG magic bytes: FF D8 FF
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const { execute } = buildResolver(
      async () =>
        new Response(jpegBytes, {
          status: 200,
          headers: { "content-type": "image/png" }, // deliberately wrong declared type
        }),
    );
    const res = await execute(
      { method: "GET", target: "https://api.example.com/img2" },
      makeCtx(workspace, "tc_sniff_no_override"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("inline");
    if (parsed.body.kind !== "inline") throw new Error("unreachable");
    // declared image/png is NOT overridden (sniff only replaces octet-stream)
    expect(parsed.body.mimeType).toBe("image/png");
    expect(parsed.body.mimeTypeSniffed).toBeUndefined();
  });

  it("declared text/plain + binary bytes → mime stays text/plain, no override (text path)", async () => {
    // File-type sniffing does not run on text paths
    const { execute } = buildResolver(
      async () =>
        new Response("hello world", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    const res = await execute(
      { method: "GET", target: "https://api.example.com/txt" },
      makeCtx(workspace, "tc_sniff_text_path"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("text");
    if (parsed.body.kind !== "text") throw new Error("unreachable");
    // No mimeTypeSniffed on text variant
    expect((parsed.body as Record<string, unknown>).mimeTypeSniffed).toBeUndefined();
  });

  it("no Content-Type header + PDF bytes → mime becomes application/pdf, mimeTypeSniffed: true", async () => {
    const bytes = pdfBytes();
    const { execute } = buildResolver(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: {}, // no content-type at all
        }),
    );
    const res = await execute(
      { method: "GET", target: "https://api.example.com/nodoc" },
      makeCtx(workspace, "tc_sniff_no_ct"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("inline");
    if (parsed.body.kind !== "inline") throw new Error("unreachable");
    expect(parsed.body.mimeType).toBe("application/pdf");
    expect(parsed.body.mimeTypeSniffed).toBe(true);
  });

  it("octet-stream + < 4 bytes → no sniff result, mime stays application/octet-stream", async () => {
    const bytes = tinyBytes(); // only 1 byte
    const { execute } = buildResolver(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const res = await execute(
      { method: "GET", target: "https://api.example.com/tiny" },
      makeCtx(workspace, "tc_sniff_tiny"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("inline");
    if (parsed.body.kind !== "inline") throw new Error("unreachable");
    expect(parsed.body.mimeType).toBe("application/octet-stream");
    expect(parsed.body.mimeTypeSniffed).toBeUndefined();
  });

  it("buffered toFile path + PNG bytes → kind=file with mimeTypeSniffed: true", async () => {
    // Test the buffered toFile path (streaming: false) directly via
    // serializeFetchResponse, since the SidecarProviderResolver sets
    // streaming: true for wantsFile requests (streaming path has no sniffing — TODO).
    const bytes = pngBytes();
    await mkdir(join(workspace, "downloads-direct"), { recursive: true });
    const fakeRes = new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    const result = await serializeFetchResponse(fakeRes, {
      workspace,
      toolCallId: "tc_sniff_tofile",
      responseMode: { toFile: "downloads-direct/sniffed.bin" },
      streaming: false, // force buffered path
    });
    expect(result.body.kind).toBe("file");
    if (result.body.kind !== "file") throw new Error("unreachable");
    expect(result.body.mimeType).toBe("image/png");
    expect(result.body.mimeTypeSniffed).toBe(true);
  });

  it("auto-spill PNG response (above inline cap) → kind=file with mimeTypeSniffed: true", async () => {
    // Build a 300KB buffer starting with PNG magic bytes to trigger auto-spill
    const png = pngBytes();
    const big = new Uint8Array(300 * 1024);
    big.set(png, 0); // place PNG signature at start
    const { execute } = buildResolver(
      async () =>
        new Response(big, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const res = await execute(
      { method: "GET", target: "https://api.example.com/big" },
      makeCtx(workspace, "tc_sniff_spill"),
    );
    const parsed = parseBody(res);
    expect(parsed.body.kind).toBe("file");
    if (parsed.body.kind !== "file") throw new Error("unreachable");
    expect(parsed.body.mimeType).toBe("image/png");
    expect(parsed.body.mimeTypeSniffed).toBe(true);
  });
});
