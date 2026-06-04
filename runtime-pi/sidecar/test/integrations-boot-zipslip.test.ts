// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import { extractBundle } from "../integrations-boot.ts";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("extractBundle — zip-slip / path-traversal write guard", () => {
  it("refuses a zip entry with a ../ traversal segment", () => {
    const bytes = zipSync({
      "ok.js": enc("export const ok = 1;"),
      "foo/../../escape.js": enc("malicious"),
    });
    return expect(extractBundle(bytes, "@scope/evil")).rejects.toThrow(
      /refusing to write outside root/,
    );
  });

  it("refuses an absolute-path zip entry", () => {
    const bytes = zipSync({
      "/../escape.js": enc("malicious"),
    });
    return expect(extractBundle(bytes, "@scope/abs")).rejects.toThrow(
      /refusing to write outside root/,
    );
  });

  it("extracts a benign nested path under the root", async () => {
    const bytes = zipSync({
      "dir/file.js": enc("export const value = 42;"),
    });
    const root = await extractBundle(bytes, "@scope/benign");
    try {
      const contents = await readFile(join(root, "dir", "file.js"), "utf8");
      expect(contents).toBe("export const value = 42;");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
