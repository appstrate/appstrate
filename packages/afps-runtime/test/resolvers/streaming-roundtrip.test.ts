// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * PR-4: streaming binary passthrough.
 *
 * Coverage for the new opt-in streaming paths on
 * {@link SidecarProviderResolver}:
 *   - `{ fromFile }` request bodies above STREAMING_THRESHOLD travel
 *     to fetch as a `ReadableStream` (duplex: "half"), no buffering.
 *   - Aborts on AbortSignal release the file handle and abort the
 *     in-flight upstream request.
 *   - `responseMode.toFile` triggers the X-Stream-Response: 1
 *     header on the sidecar request and writes upstream bytes
 *     incrementally to disk via `writeStreamToFile`.
 *   - Resolver surfaces a clean 413-style error when the sidecar
 *     refuses an oversized response.
 *   - Mid-stream upstream errors do not leave half-written files.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
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
  type RunEvent,
  type ToolContext,
} from "../../src/resolvers/index.ts";

const enc = new TextEncoder();

function sha256Hex(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return h.digest("hex");
}

function deterministicBytes(size: number, seed: number): Uint8Array {
  // Mulberry32 — deterministic, byte-stable PRNG.
  let s = seed >>> 0;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return out;
}

function makePackage(
  name: `@${string}/${string}`,
  version: string,
  type: "agent" | "provider",
  files: Record<string, string>,
): BundlePackage {
  const identity = `${name}@${version}` as PackageIdentity;
  const manifest = { name, version, type };
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

function makeCtx(workspace: string, signal: AbortSignal, toolCallId = "tc_stream"): ToolContext {
  return {
    workspace,
    toolCallId,
    runId: "run_stream_test",
    signal,
    emit: (_e: RunEvent) => {},
  };
}

function buildResolver(fetchImpl: typeof fetch) {
  return new SidecarProviderResolver({
    sidecarUrl: "http://sidecar:8080",
    fetch: fetchImpl,
  });
}

function buildBundle() {
  const root = makePackage("@acme/agent", "1.0.0", "agent", {});
  const provider = makePackage("@acme/p", "1.0.0", "provider", {
    "provider.json": JSON.stringify({ definition: { allowAllUris: true } }),
  });
  return makeBundle(root, [provider]);
}

describe("SidecarProviderResolver streaming roundtrip (PR-4)", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "afps-streaming-"));
  });

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  // ─── 1. Stream upload { fromFile } for a 6 MB file ───────────────────

  it("streams `{ fromFile }` uploads above threshold byte-for-byte (6 MB)", async () => {
    const payload = deterministicBytes(6 * 1024 * 1024, 0x60ff5e6d); // 6 MB
    const expected = sha256Hex(payload);
    const fileName = "upload-6mb.bin";
    await Bun.write(join(workspace, fileName), payload);

    let observedHash = "" as string;
    let observedDuplex = "" as string;
    let observedBodyKind = "" as string;
    const fetchImpl = (async (_url: string, init: RequestInit & { duplex?: string }) => {
      observedDuplex = init.duplex ?? "";
      observedBodyKind =
        init.body instanceof ReadableStream
          ? "stream"
          : init.body instanceof Uint8Array
            ? "u8"
            : init.body instanceof ArrayBuffer
              ? "ab"
              : typeof init.body;
      if (init.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.byteLength;
          }
        }
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        observedHash = sha256Hex(merged);
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const resolver = buildResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], buildBundle());
    const ctrl = new AbortController();
    await tools[0]!.execute(
      {
        method: "POST",
        target: "https://api.example.com/v1/upload",
        body: { fromFile: fileName },
      },
      makeCtx(workspace, ctrl.signal, "tc_6mb_up"),
    );

    expect(observedBodyKind).toBe("stream");
    expect(observedDuplex).toBe("half");
    expect(observedHash).toBe(expected);
  });

  // ─── 2. Stream upload aborts on AbortSignal ──────────────────────────

  it("aborts a streaming `{ fromFile }` upload on AbortSignal", async () => {
    const payload = deterministicBytes(6 * 1024 * 1024, 0xabcd1234);
    const fileName = "abort-source.bin";
    await Bun.write(join(workspace, fileName), payload);

    const ctrl = new AbortController();

    let upstreamSignalAborted = false;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      // Race the abort against an upstream that never responds. The
      // fetch impl must observe the resolver's AbortSignal — it
      // forwards through `signal: ctx.signal`.
      const sig = init.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (sig?.aborted) {
          upstreamSignalAborted = true;
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        sig?.addEventListener(
          "abort",
          () => {
            upstreamSignalAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }) as typeof fetch;

    const resolver = buildResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], buildBundle());

    // Schedule the abort just after we kick off the upload.
    setTimeout(() => ctrl.abort(), 20);

    let threw = false;
    try {
      await tools[0]!.execute(
        {
          method: "POST",
          target: "https://api.example.com/v1/upload",
          body: { fromFile: fileName },
        },
        makeCtx(workspace, ctrl.signal, "tc_abort"),
      );
    } catch (err) {
      threw = true;
      const name = (err as { name?: string }).name ?? "";
      // Bun surfaces "AbortError" or generic "Error" — accept either.
      expect(typeof name).toBe("string");
    }
    expect(threw).toBe(true);
    expect(upstreamSignalAborted).toBe(true);
  });

  // ─── 3. Stream download → file ───────────────────────────────────────

  it("streams `responseMode.toFile` downloads to disk with correct sha256 + size (8 MB)", async () => {
    const payload = deterministicBytes(8 * 1024 * 1024, 0xfa_ce_b0_0c);
    const expected = sha256Hex(payload);

    let stripStreamHeader = false;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      // Verify the resolver opted into streaming via X-Stream-Response: 1
      const headers = init.headers as Record<string, string>;
      if (headers["X-Stream-Response"] === "1") {
        stripStreamHeader = true;
      }
      return new Response(payload, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(payload.byteLength),
        },
      });
    }) as typeof fetch;

    const resolver = buildResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], buildBundle());
    const ctrl = new AbortController();
    const result = await tools[0]!.execute(
      {
        method: "GET",
        target: "https://api.example.com/v1/big-file",
        responseMode: { toFile: "downloads/big.bin" },
      },
      makeCtx(workspace, ctrl.signal, "tc_8mb_down"),
    );

    expect(stripStreamHeader).toBe(true);
    // Tool result is a JSON-encoded ProviderCallResponse.
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    const parsed = JSON.parse(text) as {
      status: number;
      body: { kind: string; path: string; size: number; sha256: string };
    };
    expect(parsed.status).toBe(200);
    expect(parsed.body.kind).toBe("file");
    expect(parsed.body.path).toBe("downloads/big.bin");
    expect(parsed.body.size).toBe(payload.byteLength);
    expect(parsed.body.sha256).toBe(expected);

    // And the file actually exists on disk with the correct bytes.
    const onDisk = await readFile(join(workspace, "downloads/big.bin"));
    expect(onDisk.byteLength).toBe(payload.byteLength);
    expect(sha256Hex(new Uint8Array(onDisk))).toBe(expected);
  });

  // ─── 4. Stream download with oversized Content-Length ────────────────

  it("surfaces 413 cleanly when the sidecar refuses an oversized streamed response", async () => {
    // Fake sidecar response: 413 JSON error (mirrors what the real
    // sidecar returns when upstream Content-Length > MAX_STREAMED_BODY_SIZE).
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "Response body too large" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const resolver = buildResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], buildBundle());
    const ctrl = new AbortController();
    const result = await tools[0]!.execute(
      {
        method: "GET",
        target: "https://api.example.com/v1/giant",
        responseMode: { toFile: "downloads/giant.bin" },
      },
      makeCtx(workspace, ctrl.signal, "tc_413"),
    );

    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    const parsed = JSON.parse(text) as { status: number; body: { kind: string } };
    expect(parsed.status).toBe(413);
    // Body shape on the error path is `file` (we stream the JSON
    // body to disk per ctx.streaming + toFile semantics) — the
    // important assertion is that the resolver did NOT throw and the
    // status is preserved.
    expect(["file", "text", "inline"]).toContain(parsed.body.kind);
  });

  // ─── 5. Mid-stream upstream error ────────────────────────────────────

  it("cleans up the partial file when the upstream response stream errors mid-flight", async () => {
    // Build a ReadableStream that emits a few chunks then errors out
    // — simulates upstream slamming the connection mid-body.
    const fetchImpl = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
          controller.enqueue(new Uint8Array([6, 7, 8, 9, 10]));
          // Abort the stream — readers see the error.
          controller.error(new Error("upstream EOF"));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          // No Content-Length — chunked / unknown length.
        },
      });
    }) as unknown as typeof fetch;

    const resolver = buildResolver(fetchImpl);
    const tools = await resolver.resolve([{ name: "@acme/p", version: "^1" }], buildBundle());
    const ctrl = new AbortController();

    let threw = false;
    try {
      await tools[0]!.execute(
        {
          method: "GET",
          target: "https://api.example.com/v1/dies-mid-stream",
          responseMode: { toFile: "downloads/partial.bin" },
        },
        makeCtx(workspace, ctrl.signal, "tc_mid_err"),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The partial file should have been removed by writeStreamToFile's
    // error-cleanup branch.
    let exists = true;
    try {
      await stat(join(workspace, "downloads/partial.bin"));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
