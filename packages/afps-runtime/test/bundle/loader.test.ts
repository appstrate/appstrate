// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { zipSync } from "fflate";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBundleFromBuffer,
  loadBundleFromFile,
  BundleLoadError,
} from "../../src/bundle/loader.ts";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const MINIMAL_MANIFEST = {
  name: "@acme/hello",
  version: "1.0.0",
  type: "agent",
  schemaVersion: "1.1",
  displayName: "Hello",
  author: "Acme",
};

function buildZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const map: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(entries)) {
    map[key] = typeof value === "string" ? enc(value) : value;
  }
  return zipSync(map);
}

describe("loadBundleFromBuffer — happy path", () => {
  it("loads manifest + prompt from a flat bundle", () => {
    const zip = buildZip({
      "manifest.json": JSON.stringify(MINIMAL_MANIFEST),
      "prompt.md": "Do {{input.task}}.",
    });

    const bundle = loadBundleFromBuffer(zip);

    expect(bundle.manifest.name).toBe("@acme/hello");
    expect(bundle.prompt).toBe("Do {{input.task}}.");
    expect(bundle.files["manifest.json"]).toBeDefined();
    expect(bundle.files["prompt.md"]).toBeDefined();
    expect(bundle.compressedSize).toBe(zip.length);
    expect(bundle.decompressedSize).toBeGreaterThan(0);
  });

  it("strips a single wrapper folder transparently", () => {
    const zip = buildZip({
      "wrapper/manifest.json": JSON.stringify(MINIMAL_MANIFEST),
      "wrapper/prompt.md": "inside wrapper",
      "wrapper/assets/readme.txt": "extras",
    });
    const bundle = loadBundleFromBuffer(zip);
    expect(bundle.prompt).toBe("inside wrapper");
    expect(bundle.files["manifest.json"]).toBeDefined();
    expect(bundle.files["assets/readme.txt"]).toBeDefined();
    expect(bundle.files["wrapper/manifest.json"]).toBeUndefined();
  });

  it("does NOT strip when there are multiple top-level directories", () => {
    const zip = buildZip({
      "a/manifest.json": JSON.stringify(MINIMAL_MANIFEST),
      "a/prompt.md": "x",
      "b/other.txt": "y",
    });
    // manifest.json at root missing ⇒ MISSING_MANIFEST (stripping declined)
    expect(() => loadBundleFromBuffer(zip)).toThrow(/manifest\.json/);
  });

  it("exposes arbitrary assets alongside manifest + prompt", () => {
    const zip = buildZip({
      "manifest.json": JSON.stringify(MINIMAL_MANIFEST),
      "prompt.md": "p",
      "data/sample.txt": "hello",
      "data/nested/inner.bin": new Uint8Array([1, 2, 3]),
    });
    const bundle = loadBundleFromBuffer(zip);
    expect(bundle.files["data/sample.txt"]).toEqual(enc("hello"));
    expect(bundle.files["data/nested/inner.bin"]).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("loadBundleFromBuffer — failure modes", () => {
  it("rejects oversized compressed input", () => {
    const big = new Uint8Array(11 * 1024 * 1024); // 11 MiB > default 10 MiB
    expect(() => loadBundleFromBuffer(big)).toThrow(BundleLoadError);
    expect(() => loadBundleFromBuffer(big)).toThrow(/compressed-size limit/);
  });

  it("rejects a ZIP bomb (decompressed size cap)", () => {
    const payload = new Uint8Array(2 * 1024 * 1024); // 2 MiB of zeros per file
    const zip = buildZip({
      "manifest.json": JSON.stringify(MINIMAL_MANIFEST),
      "prompt.md": "p",
      "a.bin": payload,
      "b.bin": payload,
      "c.bin": payload,
    });
    expect(() => loadBundleFromBuffer(zip, { maxDecompressedBytes: 4 * 1024 * 1024 })).toThrow(
      /decompressed bundle/,
    );
  });

  it("rejects a non-ZIP buffer", () => {
    expect(() => loadBundleFromBuffer(enc("not a zip"))).toThrow(/decompress/);
  });

  it("rejects a ZIP missing manifest.json", () => {
    const zip = buildZip({ "prompt.md": "p" });
    expect(() => loadBundleFromBuffer(zip)).toThrow(/manifest\.json/);
  });

  it("rejects a ZIP with invalid JSON in manifest.json", () => {
    const zip = buildZip({
      "manifest.json": "{not-json",
      "prompt.md": "p",
    });
    expect(() => loadBundleFromBuffer(zip)).toThrow(/not valid JSON/);
  });

  it("rejects a manifest that is not a JSON object", () => {
    const zip = buildZip({
      "manifest.json": JSON.stringify(["array"]),
      "prompt.md": "p",
    });
    expect(() => loadBundleFromBuffer(zip)).toThrow(/must be a JSON object/);
  });

  it("rejects a ZIP missing prompt.md", () => {
    const zip = buildZip({
      "manifest.json": JSON.stringify(MINIMAL_MANIFEST),
    });
    expect(() => loadBundleFromBuffer(zip)).toThrow(/prompt\.md/);
  });

  it("rejects an empty prompt.md", () => {
    const zip = buildZip({
      "manifest.json": JSON.stringify(MINIMAL_MANIFEST),
      "prompt.md": "   \n  ",
    });
    expect(() => loadBundleFromBuffer(zip)).toThrow(/empty/);
  });

  it("exposes the BundleLoadError code for programmatic handling", () => {
    const zip = buildZip({
      "manifest.json": JSON.stringify(MINIMAL_MANIFEST),
      "prompt.md": "",
    });
    try {
      loadBundleFromBuffer(zip);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BundleLoadError);
      expect((err as BundleLoadError).code).toBe("EMPTY_PROMPT");
    }
  });
});

describe("loadBundleFromBuffer — path sanitisation", () => {
  it("drops path-traversal entries", () => {
    const zip = buildZip({
      "manifest.json": JSON.stringify(MINIMAL_MANIFEST),
      "prompt.md": "p",
      "../escape.txt": "nope",
    });
    const bundle = loadBundleFromBuffer(zip);
    expect(bundle.files["../escape.txt"]).toBeUndefined();
  });

  it("drops __MACOSX metadata entries", () => {
    const zip = buildZip({
      "manifest.json": JSON.stringify(MINIMAL_MANIFEST),
      "prompt.md": "p",
      "__MACOSX/._manifest.json": "junk",
    });
    const bundle = loadBundleFromBuffer(zip);
    expect(bundle.files["__MACOSX/._manifest.json"]).toBeUndefined();
  });

  it("drops absolute-path and backslash entries", () => {
    const zip = buildZip({
      "manifest.json": JSON.stringify(MINIMAL_MANIFEST),
      "prompt.md": "p",
      "/abs.txt": "nope",
      "back\\slash.txt": "nope",
    });
    const bundle = loadBundleFromBuffer(zip);
    expect(bundle.files["/abs.txt"]).toBeUndefined();
    expect(bundle.files["back\\slash.txt"]).toBeUndefined();
  });
});

describe("loadBundleFromFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-bundle-loader-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a .afps/.zip file from disk and delegates to the buffer path", async () => {
    const zip = buildZip({
      "manifest.json": JSON.stringify(MINIMAL_MANIFEST),
      "prompt.md": "loaded from disk",
    });
    const path = join(dir, "agent.afps");
    await writeFile(path, zip);

    const bundle = await loadBundleFromFile(path);
    expect(bundle.prompt).toBe("loaded from disk");
  });
});
