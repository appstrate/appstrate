// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFileSystemStorage,
  signFsUploadToken,
  verifyFsUploadToken,
  type FsUploadTokenPayload,
} from "../src/storage-fs.ts";
import { StorageAlreadyExistsError } from "../src/storage.ts";

let basePath: string;
let storage: ReturnType<typeof createFileSystemStorage>;

beforeEach(async () => {
  basePath = await mkdtemp(join(tmpdir(), "appstrate-fs-test-"));
  storage = createFileSystemStorage({ basePath });
});

afterAll(async () => {
  // Cleanup all temp dirs (best-effort)
  if (basePath) await rm(basePath, { recursive: true, force: true });
});

describe("createFileSystemStorage", () => {
  describe("ensureBucket", () => {
    it("creates the base directory", async () => {
      const nested = join(basePath, "deep", "nested");
      const s = createFileSystemStorage({ basePath: nested });
      await s.ensureBucket();
      expect(await Bun.file(nested).exists()).toBe(false); // it's a dir, not a file
      // Verify by writing into it
      await s.uploadFile("b", "test.txt", Buffer.from("ok"));
      expect(await s.downloadFile("b", "test.txt")).toEqual(new Uint8Array(Buffer.from("ok")));
    });
  });

  describe("safePath", () => {
    it("rejects paths containing '..'", () => {
      expect(() => storage.safePath("bucket", "../outside")).toThrow("Path traversal detected");
      expect(() => storage.safePath("bucket", "../../etc/passwd")).toThrow(
        "Path traversal detected",
      );
      expect(() => storage.safePath("bucket", "foo/../bar")).toThrow("Path traversal detected");
    });

    it("returns correct keys for valid paths", () => {
      expect(storage.safePath("bucket", "file.txt")).toBe(join("bucket", "file.txt"));
      expect(storage.safePath("bucket", "sub/dir/file.txt")).toBe(
        join("bucket", "sub", "dir", "file.txt"),
      );
    });
  });

  describe("uploadFile / downloadFile", () => {
    it("round-trips binary data", async () => {
      const data = new Uint8Array([0, 1, 2, 255, 128, 64]);
      await storage.uploadFile("pkg", "data.bin", data);
      const result = await storage.downloadFile("pkg", "data.bin");
      expect(result).toEqual(data);
    });

    it("round-trips text data", async () => {
      const content = "Hello, filesystem storage!";
      await storage.uploadFile("bucket", "hello.txt", Buffer.from(content));
      const result = await storage.downloadFile("bucket", "hello.txt");
      expect(new TextDecoder().decode(result!)).toBe(content);
    });

    it("creates nested directories automatically", async () => {
      await storage.uploadFile("deep", "a/b/c/file.txt", Buffer.from("nested"));
      const result = await storage.downloadFile("deep", "a/b/c/file.txt");
      expect(new TextDecoder().decode(result!)).toBe("nested");
    });

    it("overwrites existing files", async () => {
      await storage.uploadFile("b", "f.txt", Buffer.from("v1"));
      await storage.uploadFile("b", "f.txt", Buffer.from("v2"));
      const result = await storage.downloadFile("b", "f.txt");
      expect(new TextDecoder().decode(result!)).toBe("v2");
    });

    it("returns the storage key", async () => {
      const key = await storage.uploadFile("my-bucket", "path/to/file.afps", Buffer.from("x"));
      expect(key).toBe(join("my-bucket", "path", "to", "file.afps"));
    });
  });

  describe("uploadStream", () => {
    it("streams data to disk and round-trips it", async () => {
      const content = "streamed-to-disk payload";
      await storage.uploadStream("strm", "out.txt", new Response(content).body!);
      const result = await storage.downloadFile("strm", "out.txt");
      expect(new TextDecoder().decode(result!)).toBe(content);
    });

    it("creates nested directories automatically", async () => {
      await storage.uploadStream("strm", "x/y/z/file.bin", new Response("nested").body!);
      const result = await storage.downloadFile("strm", "x/y/z/file.bin");
      expect(new TextDecoder().decode(result!)).toBe("nested");
    });

    it("returns the storage key", async () => {
      const key = await storage.uploadStream("b", "p/f.bin", new Response("k").body!);
      expect(key).toBe(join("b", "p", "f.bin"));
    });

    it("exclusive: streams to disk and refuses a second write at the same key", async () => {
      await storage.uploadStream("b", "excl.bin", new Response("first").body!, {
        exclusive: true,
      });
      expect(new TextDecoder().decode((await storage.downloadFile("b", "excl.bin"))!)).toBe(
        "first",
      );
      // Replay with the same key must fail atomically (O_EXCL) and preserve
      // the original bytes.
      await expect(
        storage.uploadStream("b", "excl.bin", new Response("second").body!, { exclusive: true }),
      ).rejects.toThrow(StorageAlreadyExistsError);
      expect(new TextDecoder().decode((await storage.downloadFile("b", "excl.bin"))!)).toBe(
        "first",
      );
    });

    it("exclusive: removes the partial file on a mid-stream error so a retry succeeds", async () => {
      // First chunk lands, then the source errors — mirrors the FS upload
      // sink's counting transform aborting past the signed max size.
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          controller.error(new Error("size cap exceeded"));
        },
      });
      await expect(
        storage.uploadStream("b", "excl-err.bin", source, { exclusive: true }),
      ).rejects.toThrow(/size cap exceeded/);
      // The partial file must be gone — a leftover would 409 every retry.
      expect(await storage.downloadFile("b", "excl-err.bin")).toBeNull();
      // A clean retry with the same key succeeds.
      await storage.uploadStream("b", "excl-err.bin", new Response("retry").body!, {
        exclusive: true,
      });
      expect(new TextDecoder().decode((await storage.downloadFile("b", "excl-err.bin"))!)).toBe(
        "retry",
      );
    });

    // Regression: a pre-buffered `new Response("string").body` stream resolves
    // synchronously and masked the real bug. The production consume path feeds a
    // file-backed stream piped through a TransformStream — that combination hung
    // forever under the old `Bun.write(path, new Response(stream))` impl and
    // wrote "[object ReadableStream]" under a bare `Bun.write(path, stream)`.
    it("round-trips a file-backed stream piped through a TransformStream", async () => {
      const payload = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
      await storage.uploadFile("strm", "source.bin", payload);
      const source = await storage.downloadStream("strm", "source.bin");
      expect(source).not.toBeNull();

      let seen = 0;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });

      await storage.uploadStream("strm", "dest.bin", source!.pipeThrough(counter));

      const result = await storage.downloadFile("strm", "dest.bin");
      expect(result).toEqual(payload);
      expect(seen).toBe(payload.byteLength);
    });

    it("flushes to disk mid-stream rather than buffering the whole payload", async () => {
      // The sink must write progressively. A default FileSink buffers every
      // chunk until end(); this asserts bytes hit disk *before* the stream
      // closes, so resident memory stays bounded under large uploads.
      const chunk = new Uint8Array(1024 * 1024); // 1 MiB
      const totalChunks = 8;
      let onDiskMidStream = -1;

      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < totalChunks; i++) controller.enqueue(chunk);
          controller.close();
        },
      });

      const probe = new TransformStream<Uint8Array, Uint8Array>({
        async transform(c, controller) {
          controller.enqueue(c);
          // After the first chunk, give the sink a tick to flush, then read the
          // on-disk size — it must be > 0 well before the stream ends.
          if (onDiskMidStream === -1) {
            await new Promise((r) => setTimeout(r, 0));
            const partial = await storage.downloadFile("strm", "big.bin");
            onDiskMidStream = partial?.byteLength ?? 0;
          }
        },
      });

      await storage.uploadStream("strm", "big.bin", source.pipeThrough(probe));

      const result = await storage.downloadFile("strm", "big.bin");
      expect(result?.byteLength).toBe(totalChunks * chunk.byteLength);
      expect(onDiskMidStream).toBeGreaterThan(0);
      expect(onDiskMidStream).toBeLessThan(totalChunks * chunk.byteLength);
    });

    it("propagates a mid-stream transform error and leaves a partial file the caller can roll back", async () => {
      const boom = new TransformStream<Uint8Array, Uint8Array>({
        transform(_chunk, controller) {
          controller.error(new Error("boom"));
        },
      });
      const source = new Response(new Uint8Array([1, 2, 3])).body!;
      await expect(
        storage.uploadStream("strm", "broken.bin", source.pipeThrough(boom)),
      ).rejects.toThrow(/boom/);
    });
  });

  describe("downloadFile", () => {
    it("returns null for non-existent files", async () => {
      const result = await storage.downloadFile("bucket", "does-not-exist.txt");
      expect(result).toBeNull();
    });

    it("returns null for non-existent bucket prefix", async () => {
      const result = await storage.downloadFile("no-such-bucket", "file.txt");
      expect(result).toBeNull();
    });
  });

  describe("downloadStream", () => {
    it("streams the file's bytes", async () => {
      await storage.uploadFile("pkg", "stream.txt", Buffer.from("streamed bytes"));
      const stream = await storage.downloadStream("pkg", "stream.txt");
      expect(stream).not.toBeNull();
      expect(await new Response(stream!).text()).toBe("streamed bytes");
    });

    it("returns null for a non-existent file", async () => {
      expect(await storage.downloadStream("bucket", "missing.txt")).toBeNull();
    });
  });

  describe("deleteFile", () => {
    it("removes an existing file", async () => {
      await storage.uploadFile("b", "to-delete.txt", Buffer.from("bye"));
      await storage.deleteFile("b", "to-delete.txt");
      const result = await storage.downloadFile("b", "to-delete.txt");
      expect(result).toBeNull();
    });

    it("does not throw for non-existent files", async () => {
      // Should silently succeed (best-effort)
      await storage.deleteFile("b", "never-existed.txt");
    });
  });

  describe("path traversal protection", () => {
    it("uploadFile rejects traversal paths", () => {
      expect(storage.uploadFile("b", "../escape.txt", Buffer.from("x"))).rejects.toThrow(
        "Path traversal detected",
      );
    });

    it("downloadFile rejects traversal paths", () => {
      expect(storage.downloadFile("b", "../../etc/passwd")).rejects.toThrow(
        "Path traversal detected",
      );
    });

    it("deleteFile rejects traversal paths", () => {
      expect(storage.deleteFile("b", "../../../tmp/evil")).rejects.toThrow(
        "Path traversal detected",
      );
    });
  });
});

describe("FS upload token keyring rotation", () => {
  const KEY1 = "new-active-upload-key-16+";
  const KEY2 = "old-retired-upload-key-16+";

  function payload(): FsUploadTokenPayload {
    return { k: "uploads/app_x/upl_y/doc.pdf", s: 1024, m: "application/pdf", e: future() };
  }

  function future(): number {
    return Math.floor(Date.now() / 1000) + 300;
  }

  it("signs with the FIRST key of a comma-separated keyring", () => {
    const p = payload();
    const token = signFsUploadToken(p, `${KEY1},${KEY2}`);
    // Verifiable with KEY1 alone — proof the first key signed it
    expect(verifyFsUploadToken(token, KEY1)).toEqual(p);
  });

  it("verifies a token signed with a non-first key (in-flight upload survives rotation)", () => {
    const p = payload();
    const inFlight = signFsUploadToken(p, KEY2);
    expect(verifyFsUploadToken(inFlight, `${KEY1},${KEY2}`)).toEqual(p);
  });

  it("accepts the array keyring form", () => {
    const p = payload();
    const inFlight = signFsUploadToken(p, [KEY2]);
    expect(verifyFsUploadToken(inFlight, [KEY1, KEY2])).toEqual(p);
  });

  it("rejects a token signed with a key removed from the keyring", () => {
    const stale = signFsUploadToken(payload(), KEY2);
    expect(verifyFsUploadToken(stale, KEY1)).toBeNull();
    expect(verifyFsUploadToken(stale, [KEY1])).toBeNull();
  });

  it("throws when signing with an empty keyring", () => {
    expect(() => signFsUploadToken(payload(), [])).toThrow(
      "signFsUploadToken requires at least one signing key",
    );
  });
});
