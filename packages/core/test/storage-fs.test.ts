// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileSystemStorage } from "../src/storage-fs.ts";

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
