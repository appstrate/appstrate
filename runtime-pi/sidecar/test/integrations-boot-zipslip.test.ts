// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
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
    return expect(extractBundle(bytes, "@scope/evil", "conn-a")).rejects.toThrow(
      /refusing to write outside root/,
    );
  });

  it("refuses an absolute-path zip entry", () => {
    const bytes = zipSync({
      "/../escape.js": enc("malicious"),
    });
    return expect(extractBundle(bytes, "@scope/abs", "conn-a")).rejects.toThrow(
      /refusing to write outside root/,
    );
  });

  it("extracts a benign nested path under the root", async () => {
    const bytes = zipSync({
      "dir/file.js": enc("export const value = 42;"),
    });
    const root = await extractBundle(bytes, "@scope/benign", "conn-a");
    try {
      const contents = await readFile(join(root, "dir", "file.js"), "utf8");
      expect(contents).toBe("export const value = 42;");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("extractBundle — per-connection directory key", () => {
  it("keys the directory by connection id, not by a slug of the label", async () => {
    // Two connections of ONE integration: same namespace, labels that a
    // truncating slug would collapse onto each other. The uuid prefix is
    // unique by construction, so the two runners never share a bundle.
    const bytes = zipSync({ "dir/file.js": enc("export const value = 42;") });
    const a = await extractBundle(bytes, "@scope/ssh", "6f1c2d3e-0000-4000-8000-000000000001");
    const b = await extractBundle(bytes, "@scope/ssh", "b2c9a17f-0000-4000-8000-000000000002");
    try {
      expect(basename(a)).toContain("6f1c2d3e");
      expect(basename(b)).toContain("b2c9a17f");
      expect(basename(a).replace(/-[^-]+$/, "")).not.toBe(basename(b).replace(/-[^-]+$/, ""));
      // CONTROL — the integration half of the key is still the namespace, and
      // a connectionless integration (one runner by construction) drops the
      // connection segment rather than inventing one.
      expect(basename(a)).toStartWith("afps-integ-scope_ssh-");
      expect(basename(b)).toStartWith("afps-integ-scope_ssh-");
      const none = await extractBundle(bytes, "@scope/ssh", undefined);
      try {
        expect(basename(none)).toStartWith("afps-integ-scope_ssh-");
        expect(basename(none)).not.toContain("6f1c2d3e");
      } finally {
        await rm(none, { recursive: true, force: true });
      }
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });
});
