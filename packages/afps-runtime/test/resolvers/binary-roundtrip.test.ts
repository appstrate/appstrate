// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Regression suite for issues #149 / #151: the `<provider>_call` runtime
 * MUST preserve binary bytes end-to-end on both upload (`{ fromFile }`)
 * and download (inline / auto-spill / `responseMode.toFile`).
 *
 * The sidecar HTTP layer (`runtime-pi/sidecar/app.ts`) already round-trips
 * bytes correctly via `arrayBuffer()`. The bug this suite guards against
 * lived in `serializeFetchResponse` (client-side resolver), which used
 * `res.text()` and corrupted any non-UTF8 payload (PDF, PNG, ZIP, …)
 * coming back from Google Drive, GitHub release artefacts, etc.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from "node:fs/promises";
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
  LocalProviderResolver,
  SidecarProviderResolver,
  type ProviderCallResponseBody,
  type RunEvent,
  type ToolContext,
} from "../../src/resolvers/index.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────

const enc = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Minimal PNG: 1x1 transparent pixel (well under inline cap). ~70 bytes. */
function tinyPng(): Uint8Array {
  // Hand-crafted minimal PNG (signature + IHDR + IDAT + IEND).
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
}

/** Minimal valid PDF (~400 bytes) — well under inline cap. */
function tinyPdf(): Uint8Array {
  const text = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000110 00000 n
trailer
<< /Size 4 /Root 1 0 R >>
startxref
178
%%EOF
`;
  // Add a stretch of high-bit bytes to make sure the test would catch any
  // accidental UTF-8 decode: a real PDF often has binary streams.
  const base = enc.encode(text);
  const tail = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0x80, 0x81, 0x82]);
  const out = new Uint8Array(base.byteLength + tail.byteLength);
  out.set(base, 0);
  out.set(tail, base.byteLength);
  return out;
}

/** Deterministic 60 KB pseudo-random buffer (no fixture file needed). */
function deterministicBytes(size: number, seed: number): Uint8Array {
  // Mulberry32 — tiny deterministic PRNG. Stable across runs.
  let state = seed >>> 0;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = (t ^ (t >>> 14)) & 0xff;
  }
  return out;
}

// ─── Bundle helpers ────────────────────────────────────────────────────

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

function makeCtx(workspace: string, toolCallId = "tc_test"): ToolContext {
  return {
    workspace,
    toolCallId,
    runId: "run_test",
    signal: new AbortController().signal,
    emit: (_e: RunEvent) => {},
  };
}

interface Captured {
  url: string;
  init: RequestInit;
  bodyBytes: Uint8Array | undefined;
}

/**
 * Build a fake fetch that captures the outgoing request body (including
 * binary bytes) and returns whatever the test wants. Reads the request
 * body via `arrayBuffer()` so we can verify byte-perfect uploads.
 */
function makeFetchCapture(
  responder: (req: { url: string; init: RequestInit }) => Promise<Response>,
): { calls: Captured[]; fetchImpl: typeof fetch } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const captured: Captured = { url: String(url), init: init ?? {}, bodyBytes: undefined };
    if (init?.body) {
      if (init.body instanceof Uint8Array) {
        captured.bodyBytes = new Uint8Array(init.body);
      } else if (typeof init.body === "string") {
        captured.bodyBytes = enc.encode(init.body);
      } else if (init.body instanceof ArrayBuffer) {
        captured.bodyBytes = new Uint8Array(init.body);
      }
    }
    calls.push(captured);
    return responder({ url: captured.url, init: captured.init });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

// ─── Suite scaffolding ────────────────────────────────────────────────

describe("provider-tool binary round-trip", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "afps-roundtrip-"));
  });

  afterAll(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── Upload (request body) ───────────────────────────────────────────

  describe("upload — { fromFile }", () => {
    it("preserves PDF bytes byte-for-byte through the sidecar resolver", async () => {
      const pdf = tinyPdf();
      const expectedSha = sha256(pdf);
      await writeFile(join(workspace, "sample.pdf"), pdf);

      const root = makePackage("@acme/agent", "1.0.0", "agent", {});
      const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
        "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
      });
      const bundle = makeBundle(root, [providerPkg]);

      const { calls, fetchImpl } = makeFetchCapture(async () => {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      });
      const resolver = new SidecarProviderResolver({
        sidecarUrl: "http://sidecar:8080",
        fetch: fetchImpl,
      });
      const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], bundle);
      await tools[0]!.execute(
        {
          method: "POST",
          target: "https://upload.example.com/v1/file",
          body: { fromFile: "sample.pdf" },
        },
        makeCtx(workspace, "tc_upload_pdf"),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]!.bodyBytes).toBeDefined();
      expect(sha256(calls[0]!.bodyBytes!)).toBe(expectedSha);
      expect(calls[0]!.bodyBytes!.byteLength).toBe(pdf.byteLength);
    });

    it("rejects { fromFile } pointing outside the workspace with RESOLVER_PATH_OUTSIDE_WORKSPACE", async () => {
      const root = makePackage("@acme/agent", "1.0.0", "agent", {});
      const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
        "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
      });
      const bundle = makeBundle(root, [providerPkg]);

      const { fetchImpl } = makeFetchCapture(async () => new Response("", { status: 200 }));
      const resolver = new SidecarProviderResolver({
        sidecarUrl: "http://sidecar:8080",
        fetch: fetchImpl,
      });
      const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], bundle);
      try {
        await tools[0]!.execute(
          {
            method: "POST",
            target: "https://api.example.com/x",
            body: { fromFile: "../../etc/passwd" },
          },
          makeCtx(workspace, "tc_traversal"),
        );
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as { code?: string }).code).toBe("RESOLVER_PATH_OUTSIDE_WORKSPACE");
      }
    });

    it("rejects absolute { fromFile } paths", async () => {
      const root = makePackage("@acme/agent", "1.0.0", "agent", {});
      const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
        "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
      });
      const bundle = makeBundle(root, [providerPkg]);

      const { fetchImpl } = makeFetchCapture(async () => new Response("", { status: 200 }));
      const resolver = new SidecarProviderResolver({
        sidecarUrl: "http://sidecar:8080",
        fetch: fetchImpl,
      });
      const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], bundle);
      try {
        await tools[0]!.execute(
          {
            method: "POST",
            target: "https://api.example.com/x",
            body: { fromFile: "/etc/passwd" },
          },
          makeCtx(workspace, "tc_abs"),
        );
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_PATH_OUTSIDE_WORKSPACE");
      }
    });

    it("refuses symlinked { fromFile } targets", async () => {
      // Create a file outside the workspace and symlink it from inside.
      // resolveSafePath's realpath check should reject the resolution.
      const outside = await mkdtemp(join(tmpdir(), "afps-outside-"));
      const target = join(outside, "secret.bin");
      await writeFile(target, new Uint8Array([1, 2, 3, 4]));
      const linkPath = join(workspace, "link-secret");
      await symlink(target, linkPath);

      try {
        const root = makePackage("@acme/agent", "1.0.0", "agent", {});
        const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
          "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
        });
        const bundle = makeBundle(root, [providerPkg]);

        const { fetchImpl } = makeFetchCapture(async () => new Response("", { status: 200 }));
        const resolver = new SidecarProviderResolver({
          sidecarUrl: "http://sidecar:8080",
          fetch: fetchImpl,
        });
        const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], bundle);
        try {
          await tools[0]!.execute(
            {
              method: "POST",
              target: "https://api.example.com/x",
              body: { fromFile: "link-secret" },
            },
            makeCtx(workspace, "tc_symlink"),
          );
          throw new Error("expected throw");
        } catch (err) {
          expect((err as { code?: string }).code).toBe("RESOLVER_PATH_OUTSIDE_WORKSPACE");
        }
      } finally {
        await rm(outside, { recursive: true, force: true }).catch(() => {});
        await rm(linkPath, { force: true }).catch(() => {});
      }
    });

    it("streams { fromFile } above STREAMING_THRESHOLD via sidecar resolver (5 MB + 1 byte)", async () => {
      // After PR-4 the sidecar resolver opts `{ fromFile }` references
      // larger than STREAMING_THRESHOLD (1 MB) into the streaming path
      // — they no longer hit the legacy 5 MB MAX_REQUEST_BODY_SIZE cap.
      // The hard ceiling is now MAX_STREAMED_BODY_SIZE (100 MB).
      const big = new Uint8Array(5 * 1024 * 1024 + 1);
      const path = join(workspace, "huge.bin");
      await writeFile(path, big);

      const root = makePackage("@acme/agent", "1.0.0", "agent", {});
      const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
        "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
      });
      const bundle = makeBundle(root, [providerPkg]);

      const { calls, fetchImpl } = makeFetchCapture(async () => new Response("", { status: 200 }));
      const resolver = new SidecarProviderResolver({
        sidecarUrl: "http://sidecar:8080",
        fetch: fetchImpl,
      });
      const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], bundle);
      const result = await tools[0]!.execute(
        {
          method: "POST",
          target: "https://api.example.com/x",
          body: { fromFile: "huge.bin" },
        },
        makeCtx(workspace, "tc_5mb_stream"),
      );
      // Returns a normal response — no throw, body was streamed.
      expect(result).toBeDefined();
      expect(calls).toHaveLength(1);
      // Streaming mode: fetch saw a ReadableStream body, NOT bytes.
      expect(calls[0]!.init.body).toBeInstanceOf(ReadableStream);
      // The resolver sets Content-Length explicitly + duplex: "half".
      const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
      expect(headers["Content-Length"]).toBe(String(big.byteLength));
    });
  });

  // ─── Download (response body) — Sidecar ──────────────────────────────

  describe("download — sidecar resolver", () => {
    function buildSidecarResolver(
      responder: (req: { url: string; init: RequestInit }) => Promise<Response>,
    ): {
      execute: (
        params: Parameters<
          Awaited<ReturnType<SidecarProviderResolver["resolve"]>>[number]["execute"]
        >[0],
        ctx: ToolContext,
      ) => Promise<unknown>;
      calls: Captured[];
    } {
      const root = makePackage("@acme/agent", "1.0.0", "agent", {});
      const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
        "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
      });
      const bundle = makeBundle(root, [providerPkg]);

      const { calls, fetchImpl } = makeFetchCapture(responder);
      const resolver = new SidecarProviderResolver({
        sidecarUrl: "http://sidecar:8080",
        fetch: fetchImpl,
      });
      let executor:
        | Awaited<ReturnType<SidecarProviderResolver["resolve"]>>[number]["execute"]
        | undefined;
      const ready = (async () => {
        const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], bundle);
        executor = tools[0]!.execute;
      })();

      return {
        async execute(params, ctx) {
          await ready;
          return executor!(params, ctx);
        },
        calls,
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

    it("inlines small PNG bytes as base64 (kind=inline) with byte-perfect round-trip", async () => {
      const png = tinyPng();
      const expectedSha = sha256(png);

      const { execute } = buildSidecarResolver(
        async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
      );
      const res = await execute(
        { method: "GET", target: "https://api.example.com/img" },
        makeCtx(workspace, "tc_dl_png"),
      );
      const parsed = parseBody(res);
      expect(parsed.status).toBe(200);
      expect(parsed.body.kind).toBe("inline");
      if (parsed.body.kind !== "inline") throw new Error("unreachable");
      expect(parsed.body.encoding).toBe("base64");
      expect(parsed.body.mimeType).toBe("image/png");
      expect(parsed.body.size).toBe(png.byteLength);
      const decoded = new Uint8Array(Buffer.from(parsed.body.data, "base64"));
      expect(sha256(decoded)).toBe(expectedSha);
    });

    it("auto-spills payloads larger than the inline cap to responses/<toolCallId>.bin", async () => {
      const blob = deterministicBytes(60 * 1024, 0xc0ffee); // kept for sha fixture symmetry — not used in assertions.
      // Use 300KB to definitively exceed defaultInlineLimit (256 KB = 256*1024).
      const big = deterministicBytes(300 * 1024, 0xc0ffee);
      const expectedSha = sha256(big);

      const { execute } = buildSidecarResolver(
        async () =>
          new Response(big, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
      );
      const res = await execute(
        { method: "GET", target: "https://api.example.com/blob" },
        makeCtx(workspace, "tc_dl_spill"),
      );
      const parsed = parseBody(res);
      expect(parsed.body.kind).toBe("file");
      if (parsed.body.kind !== "file") throw new Error("unreachable");
      expect(parsed.body.path).toBe("responses/tc_dl_spill.bin");
      expect(parsed.body.size).toBe(big.byteLength);
      expect(parsed.body.sha256).toBe(expectedSha);

      const onDisk = await readFile(join(workspace, "responses", "tc_dl_spill.bin"));
      expect(sha256(new Uint8Array(onDisk))).toBe(expectedSha);
      void blob;
    });

    it("rejects responseMode.toFile that points at a pre-existing symlink in the workspace (M4)", async () => {
      // An attacker could pre-place a symlink inside the workspace pointing
      // outside it. resolveSafeOutputPath must refuse to write through it.
      const outside = await mkdtemp(join(tmpdir(), "afps-outside-tofile-"));
      const targetFile = join(outside, "sensitive.dat");
      await writeFile(targetFile, new Uint8Array([0xde, 0xad]));
      // Place the symlink inside the workspace.
      const symlinkInWorkspace = join(workspace, "output-link.bin");
      await symlink(targetFile, symlinkInWorkspace);

      try {
        const { execute } = buildSidecarResolver(
          async () =>
            new Response(new Uint8Array([1, 2, 3]), {
              status: 200,
              headers: { "content-type": "application/octet-stream" },
            }),
        );
        try {
          await execute(
            {
              method: "GET",
              target: "https://api.example.com/x",
              responseMode: { toFile: "output-link.bin" },
            },
            makeCtx(workspace, "tc_tofile_symlink"),
          );
          throw new Error("expected throw");
        } catch (err) {
          expect((err as { code?: string }).code).toBe("RESOLVER_PATH_OUTSIDE_WORKSPACE");
        }
      } finally {
        await rm(outside, { recursive: true, force: true }).catch(() => {});
        await rm(symlinkInWorkspace, { force: true }).catch(() => {});
      }
    });

    it("honours responseMode.toFile (writes the requested workspace path)", async () => {
      const pdf = tinyPdf();
      const expectedSha = sha256(pdf);

      const { execute } = buildSidecarResolver(
        async () =>
          new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } }),
      );
      await mkdir(join(workspace, "downloads"), { recursive: true });
      const res = await execute(
        {
          method: "GET",
          target: "https://api.example.com/doc",
          responseMode: { toFile: "downloads/got.pdf" },
        },
        makeCtx(workspace, "tc_dl_tofile"),
      );
      const parsed = parseBody(res);
      expect(parsed.body.kind).toBe("file");
      if (parsed.body.kind !== "file") throw new Error("unreachable");
      expect(parsed.body.path).toBe("downloads/got.pdf");
      expect(parsed.body.size).toBe(pdf.byteLength);
      expect(parsed.body.sha256).toBe(expectedSha);

      const onDisk = await readFile(join(workspace, "downloads", "got.pdf"));
      expect(sha256(new Uint8Array(onDisk))).toBe(expectedSha);
    });

    it("rejects responseMode.toFile that traverses outside the workspace", async () => {
      const { execute } = buildSidecarResolver(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
      );
      try {
        await execute(
          {
            method: "GET",
            target: "https://api.example.com/x",
            responseMode: { toFile: "../../etc/x" },
          },
          makeCtx(workspace, "tc_dl_traverse"),
        );
        throw new Error("expected throw");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("RESOLVER_PATH_OUTSIDE_WORKSPACE");
      }
    });

    it("returns text body for application/json (no base64)", async () => {
      const { execute } = buildSidecarResolver(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
      );
      const res = await execute(
        { method: "GET", target: "https://api.example.com/x" },
        makeCtx(workspace, "tc_dl_json"),
      );
      const parsed = parseBody(res);
      expect(parsed.body.kind).toBe("text");
      if (parsed.body.kind !== "text") throw new Error("unreachable");
      expect(JSON.parse(parsed.body.text)).toEqual({ ok: true });
    });

    it("treats application/octet-stream as binary even if bytes happen to be ASCII", async () => {
      // Strict whitelist: octet-stream is not text-like, so even a body
      // of "hello" must come back as base64-encoded `inline`. This
      // guards against a regression where the test response would
      // accidentally decode as text and corrupt downstream consumers
      // who expect binary.
      const { execute } = buildSidecarResolver(
        async () =>
          new Response("hello", {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
      );
      const res = await execute(
        { method: "GET", target: "https://api.example.com/x" },
        makeCtx(workspace, "tc_dl_octet_ascii"),
      );
      const parsed = parseBody(res);
      expect(parsed.body.kind).toBe("inline");
      if (parsed.body.kind !== "inline") throw new Error("unreachable");
      expect(parsed.body.mimeType).toBe("application/octet-stream");
      expect(Buffer.from(parsed.body.data, "base64").toString("utf8")).toBe("hello");
    });

    it("forwards X-Max-Response-Size when the agent asks for a large maxInlineBytes", async () => {
      const { calls, execute } = buildSidecarResolver(
        async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
      );
      await execute(
        {
          method: "GET",
          target: "https://api.example.com/x",
          responseMode: { maxInlineBytes: 200_000 },
        },
        makeCtx(workspace, "tc_xmax"),
      );
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers["X-Max-Response-Size"]).toBe("200000");
    });

    it("caps X-Max-Response-Size at ABSOLUTE_MAX_RESPONSE_SIZE", async () => {
      const { calls, execute } = buildSidecarResolver(
        async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
      );
      await execute(
        {
          method: "GET",
          target: "https://api.example.com/x",
          responseMode: { maxInlineBytes: 9_000_000 },
        },
        makeCtx(workspace, "tc_xmax_cap"),
      );
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers["X-Max-Response-Size"]).toBe("1000000");
    });
  });

  // ─── Download (response body) — Local resolver parity ────────────────

  describe("download — LocalProviderResolver parity", () => {
    function buildLocalResolver(
      responder: (req: { url: string; init: RequestInit }) => Promise<Response>,
    ): {
      execute: (
        params: Parameters<
          Awaited<ReturnType<LocalProviderResolver["resolve"]>>[number]["execute"]
        >[0],
        ctx: ToolContext,
      ) => Promise<unknown>;
    } {
      const root = makePackage("@acme/agent", "1.0.0", "agent", {});
      const providerPkg = makePackage("@acme/p", "1.0.0", "provider", {
        "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
      });
      const bundle = makeBundle(root, [providerPkg]);

      const { fetchImpl } = makeFetchCapture(responder);
      const resolver = new LocalProviderResolver({
        creds: { version: 1, providers: { "@acme/p": { fields: {} } } },
        fetch: fetchImpl,
      });
      let executor:
        | Awaited<ReturnType<LocalProviderResolver["resolve"]>>[number]["execute"]
        | undefined;
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
      body: ProviderCallResponseBody;
    } {
      const r = result as { content: Array<{ type: string; text: string }> };
      return JSON.parse(r.content[0]!.text);
    }

    it("inlines a small PNG as base64 with byte-perfect round-trip", async () => {
      const png = tinyPng();
      const expectedSha = sha256(png);
      const { execute } = buildLocalResolver(
        async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
      );
      const res = await execute(
        { method: "GET", target: "https://api.example.com/x" },
        makeCtx(workspace, "tc_local_inline"),
      );
      const parsed = parseBody(res);
      expect(parsed.body.kind).toBe("inline");
      if (parsed.body.kind !== "inline") throw new Error("unreachable");
      const decoded = new Uint8Array(Buffer.from(parsed.body.data, "base64"));
      expect(sha256(decoded)).toBe(expectedSha);
    });

    it("auto-spills oversize binary responses to a workspace file", async () => {
      const big = randomBytes(300 * 1024); // 300KB > 256KB default
      const expectedSha = sha256(new Uint8Array(big));
      const { execute } = buildLocalResolver(
        async () =>
          new Response(big, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
      );
      const res = await execute(
        { method: "GET", target: "https://api.example.com/x" },
        makeCtx(workspace, "tc_local_spill"),
      );
      const parsed = parseBody(res);
      expect(parsed.body.kind).toBe("file");
      if (parsed.body.kind !== "file") throw new Error("unreachable");
      expect(parsed.body.path).toBe("responses/tc_local_spill.bin");
      expect(parsed.body.sha256).toBe(expectedSha);
      const onDisk = await readFile(join(workspace, "responses", "tc_local_spill.bin"));
      expect(sha256(new Uint8Array(onDisk))).toBe(expectedSha);
    });

    it("returns text for application/json", async () => {
      const { execute } = buildLocalResolver(
        async () =>
          new Response(JSON.stringify({ greet: "hi" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const res = await execute(
        { method: "GET", target: "https://api.example.com/x" },
        makeCtx(workspace, "tc_local_json"),
      );
      const parsed = parseBody(res);
      expect(parsed.body.kind).toBe("text");
      if (parsed.body.kind !== "text") throw new Error("unreachable");
      expect(JSON.parse(parsed.body.text)).toEqual({ greet: "hi" });
    });

    it("honours responseMode.toFile under the workspace", async () => {
      const pdf = tinyPdf();
      const expectedSha = sha256(pdf);
      const { execute } = buildLocalResolver(
        async () =>
          new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } }),
      );
      const res = await execute(
        {
          method: "GET",
          target: "https://api.example.com/x",
          responseMode: { toFile: "downloads/local-got.pdf" },
        },
        makeCtx(workspace, "tc_local_tofile"),
      );
      const parsed = parseBody(res);
      expect(parsed.body.kind).toBe("file");
      if (parsed.body.kind !== "file") throw new Error("unreachable");
      expect(parsed.body.path).toBe("downloads/local-got.pdf");
      const onDisk = await readFile(join(workspace, "downloads", "local-got.pdf"));
      expect(sha256(new Uint8Array(onDisk))).toBe(expectedSha);
    });
  });
});
