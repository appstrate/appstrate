// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { zipSync } from "fflate";
import { unzipBounded, DecompressionLimitError } from "../src/unzip-bounded.ts";

function makeZip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 6 });
}

describe("unzipBounded", () => {
  it("returns file entries within budget", () => {
    const zip = makeZip({
      "manifest.json": new TextEncoder().encode('{"name":"x"}'),
      "a/b.txt": new TextEncoder().encode("hello"),
    });
    const out = unzipBounded(zip, { maxDecompressedBytes: 1024 * 1024 });
    expect(new TextDecoder().decode(out["manifest.json"]!)).toBe('{"name":"x"}');
    expect(new TextDecoder().decode(out["a/b.txt"]!)).toBe("hello");
  });

  it("aborts a highly-compressible bomb before full materialization", () => {
    // 8 MB of zeros compresses to a few KB; budget is 1 MB.
    const big = new Uint8Array(8 * 1024 * 1024); // all zeros → tiny compressed
    const zip = makeZip({ "bomb.bin": big });
    expect(zip.length).toBeLessThan(1024 * 1024); // compressed is small
    expect(() => unzipBounded(zip, { maxDecompressedBytes: 1024 * 1024 })).toThrow(
      DecompressionLimitError,
    );
  });

  it("enforces the reason on budget breach", () => {
    const big = new Uint8Array(4 * 1024 * 1024);
    const zip = makeZip({ "z.bin": big });
    try {
      unzipBounded(zip, { maxDecompressedBytes: 512 * 1024 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DecompressionLimitError);
      expect((err as DecompressionLimitError).reason).toBe("decompressed-budget-exceeded");
    }
  });

  it("enforces per-file cap", () => {
    const zip = makeZip({
      "small.txt": new TextEncoder().encode("ok"),
      "big.bin": new Uint8Array(2 * 1024 * 1024),
    });
    expect(() =>
      unzipBounded(zip, { maxDecompressedBytes: 100 * 1024 * 1024, maxFileBytes: 1024 * 1024 }),
    ).toThrow(DecompressionLimitError);
  });

  it("enforces the file-count cap", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.txt`] = new TextEncoder().encode("x");
    const zip = makeZip(files);
    expect(() => unzipBounded(zip, { maxDecompressedBytes: 1024 * 1024, maxFiles: 5 })).toThrow(
      DecompressionLimitError,
    );
  });

  it("excludes directory entries from the output", () => {
    const zip = makeZip({
      "dir/": new Uint8Array(0),
      "dir/file.txt": new TextEncoder().encode("y"),
    });
    const out = unzipBounded(zip, { maxDecompressedBytes: 1024 * 1024 });
    expect(out["dir/"]).toBeUndefined();
    expect(new TextDecoder().decode(out["dir/file.txt"]!)).toBe("y");
  });
});
