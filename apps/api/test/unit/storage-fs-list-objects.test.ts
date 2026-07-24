// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the filesystem `listObjects` implementation: recursive walk,
 * in-bucket key normalization, size reporting, prefix filter, and the
 * missing-bucket (empty) case.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSystemStorage } from "@appstrate/core/storage-fs";
import type { Storage, StorageObject } from "@appstrate/core/storage";

async function collect(iter: AsyncIterable<StorageObject>): Promise<StorageObject[]> {
  const out: StorageObject[] = [];
  for await (const o of iter) out.push(o);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

describe("filesystem listObjects", () => {
  let base: string;
  let storage: Storage;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "appstrate-liststorage-"));
    storage = createFileSystemStorage({ basePath: base });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("yields every object's in-bucket key (POSIX-separated) with its size", async () => {
    await storage.uploadFile("documents", "app1/doc1/a.txt", new TextEncoder().encode("hello"));
    await storage.uploadFile("documents", "app1/doc2/b.txt", new TextEncoder().encode("world!!"));
    await storage.uploadFile("documents", "app2/doc3/c.bin", new Uint8Array([1, 2, 3]));

    const objects = await collect(storage.listObjects("documents"));
    expect(objects.map((o) => o.key)).toEqual([
      "app1/doc1/a.txt",
      "app1/doc2/b.txt",
      "app2/doc3/c.bin",
    ]);
    // Sizes are the byte lengths written.
    const byKey = new Map(objects.map((o) => [o.key, o.size]));
    expect(byKey.get("app1/doc1/a.txt")).toBe(5);
    expect(byKey.get("app1/doc2/b.txt")).toBe(7);
    expect(byKey.get("app2/doc3/c.bin")).toBe(3);
  });

  it("filters to the given in-bucket prefix", async () => {
    await storage.uploadFile("documents", "app1/x.txt", new TextEncoder().encode("x"));
    await storage.uploadFile("documents", "app2/y.txt", new TextEncoder().encode("y"));

    const only1 = await collect(storage.listObjects("documents", "app1/"));
    expect(only1.map((o) => o.key)).toEqual(["app1/x.txt"]);
  });

  it("yields nothing for a bucket that was never written to", async () => {
    const objects = await collect(storage.listObjects("empty-bucket"));
    expect(objects).toEqual([]);
  });

  it("round-trips: a listed key is deletable via deleteFile", async () => {
    await storage.uploadFile("documents", "app1/doc1/a.txt", new TextEncoder().encode("hello"));
    const [obj] = await collect(storage.listObjects("documents"));
    await storage.deleteFile("documents", obj!.key);
    expect(await collect(storage.listObjects("documents"))).toEqual([]);
  });
});
