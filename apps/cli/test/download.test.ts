// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamDownload, formatProgress } from "../src/lib/download.ts";
import type { DownloadProgress } from "../src/lib/download.ts";

const workDirs: string[] = [];
async function tmpDest(name = "download.bin"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "appstrate-dl-test-"));
  workDirs.push(dir);
  return join(dir, name);
}
afterEach(async () => {
  for (const d of workDirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

/** A Response streaming `chunks`, with an optional explicit Content-Length. */
function streamingResponse(
  chunks: Uint8Array[],
  opts: { contentLength?: number | null } = {},
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(c);
      ctrl.close();
    },
  });
  const headers = new Headers();
  const len =
    opts.contentLength === undefined
      ? chunks.reduce((a, c) => a + c.byteLength, 0)
      : opts.contentLength;
  if (len !== null) headers.set("content-length", String(len));
  return new Response(body, { status: 200, headers });
}

/** SHA-256 hex of bytes via Bun (the value streamDownload should return). */
function sha(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

describe("streamDownload", () => {
  it("writes the file, returns bytesWritten + on-the-fly sha256", async () => {
    const dest = await tmpDest();
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const res = await streamDownload("https://example/asset", dest, {
      fetchImpl: async () => streamingResponse([payload.subarray(0, 4), payload.subarray(4)]),
    });
    expect(res.bytesWritten).toBe(8);
    expect(res.sha256).toBe(sha(payload));
    expect(new Uint8Array(await readFile(dest))).toEqual(payload);
  });

  it("reports progress with total from Content-Length", async () => {
    const dest = await tmpDest();
    const chunks = [new Uint8Array(10), new Uint8Array(10)];
    const ticks: DownloadProgress[] = [];
    await streamDownload("https://example/asset", dest, {
      fetchImpl: async () => streamingResponse(chunks, { contentLength: 20 }),
      onProgress: (p) => ticks.push(p),
    });
    // A final forced tick always fires; it must report the full byte count + total.
    const last = ticks.at(-1)!;
    expect(last.received).toBe(20);
    expect(last.total).toBe(20);
  });

  it("reports progress with null total when Content-Length is absent", async () => {
    const dest = await tmpDest();
    const ticks: DownloadProgress[] = [];
    await streamDownload("https://example/asset", dest, {
      fetchImpl: async () => streamingResponse([new Uint8Array(5)], { contentLength: null }),
      onProgress: (p) => ticks.push(p),
    });
    expect(ticks.at(-1)!.total).toBeNull();
  });

  it("throws GET … HTTP <status> on a non-2xx and writes nothing", async () => {
    const dest = await tmpDest();
    await expect(
      streamDownload("https://example/missing", dest, {
        fetchImpl: async () => new Response("nope", { status: 404, statusText: "Not Found" }),
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(await Bun.file(dest).exists()).toBe(false);
  });

  it("aborts with a stall error and removes the partial file", async () => {
    const dest = await tmpDest();
    // Stream: one chunk, then hang forever → the stall watchdog fires.
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new Uint8Array([1, 2, 3]));
        // never close / enqueue again
      },
    });
    await expect(
      streamDownload("https://example/slow", dest, {
        stallTimeoutMs: 20,
        fetchImpl: async () => new Response(body, { status: 200 }),
      }),
    ).rejects.toThrow(/stalled: no data/);
    expect(await Bun.file(dest).exists()).toBe(false);
  });

  it("aborts with a total-timeout error when the whole transfer runs long", async () => {
    const dest = await tmpDest();
    // A chunk every 15ms keeps the stall watchdog happy, but the total cap (30ms) trips.
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        await new Promise((r) => setTimeout(r, 15));
        ctrl.enqueue(new Uint8Array([0]));
      },
    });
    await expect(
      streamDownload("https://example/long", dest, {
        stallTimeoutMs: 500,
        totalTimeoutMs: 30,
        fetchImpl: async () => new Response(body, { status: 200 }),
      }),
    ).rejects.toThrow(/timed out/);
    expect(await Bun.file(dest).exists()).toBe(false);
  });

  it("propagates a network error from fetch", async () => {
    const dest = await tmpDest();
    await expect(
      streamDownload("https://example/asset", dest, {
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("formatProgress", () => {
  it("includes percent when total is known", () => {
    const s = formatProgress({
      received: 5 * 1024 * 1024,
      total: 10 * 1024 * 1024,
      rateBytesPerSec: 1024 * 1024,
    });
    expect(s).toContain("(50%)");
    expect(s).toContain("MB/s");
  });

  it("omits percent when total is unknown", () => {
    const s = formatProgress({ received: 1024, total: null, rateBytesPerSec: 512 });
    expect(s).not.toContain("%");
  });
});
