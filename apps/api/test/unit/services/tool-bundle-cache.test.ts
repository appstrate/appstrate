// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { BundleError } from "@appstrate/afps-runtime/bundle";
import { ToolBundleCache } from "../../../src/services/adapters/tool-bundle-cache.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : "");

describe("ToolBundleCache", () => {
  it("compiles a draft tool, emits tool.js, rewrites manifest.entrypoint", async () => {
    const cache = new ToolBundleCache();
    const manifest = {
      name: "@t/a",
      version: "1.0.0",
      type: "tool",
      entrypoint: "tool.ts",
    };
    const files = new Map<string, Uint8Array>([
      ["tool.ts", enc("export default () => ({ name: 'a' });\n")],
      ["TOOL.md", enc("docs")],
      ["manifest.json", enc(JSON.stringify(manifest, null, 2))],
    ]);

    const result = await cache.bundle({ files, manifest, toolId: "@t/a" });

    expect(result.files.has("tool.ts")).toBe(false);
    expect(result.files.has("tool.js")).toBe(true);
    expect(result.files.has("TOOL.md")).toBe(true);
    expect(result.manifest.entrypoint).toBe("tool.js");
    expect(dec(result.files.get("manifest.json"))).toContain('"entrypoint": "tool.js"');
  });

  it("caches compiled output — second call does not re-bundle", async () => {
    const cache = new ToolBundleCache();
    const manifest = {
      name: "@t/cache",
      version: "1.0.0",
      type: "tool",
      entrypoint: "tool.ts",
    };
    const files = new Map<string, Uint8Array>([
      ["tool.ts", enc("export default () => ({ name: 'cache' });\n")],
    ]);

    const a = await cache.bundle({ files, manifest, toolId: "@t/cache" });
    const b = await cache.bundle({ files, manifest, toolId: "@t/cache" });

    // Same bytes instance → served from cache
    expect(a.files.get("tool.js")).toBe(b.files.get("tool.js"));
  });

  it("does not share cache entries across different source bytes", async () => {
    const cache = new ToolBundleCache();
    const manifest = {
      name: "@t/dedup",
      version: "1.0.0",
      type: "tool",
      entrypoint: "tool.ts",
    };
    const filesA = new Map<string, Uint8Array>([
      ["tool.ts", enc("export default () => ({ v: 'a' });\n")],
    ]);
    const filesB = new Map<string, Uint8Array>([
      ["tool.ts", enc("export default () => ({ v: 'b' });\n")],
    ]);

    const a = await cache.bundle({ files: filesA, manifest, toolId: "@t/dedup" });
    const b = await cache.bundle({ files: filesB, manifest, toolId: "@t/dedup" });

    expect(a.files.get("tool.js")).not.toBe(b.files.get("tool.js"));
    expect(dec(a.files.get("tool.js"))).not.toBe(dec(b.files.get("tool.js")));
  });

  it("throws BundleError(TOOL_BUNDLE_FAILED) when entrypoint is missing", async () => {
    const cache = new ToolBundleCache();
    const manifest = { name: "@t/no-entry", version: "1.0.0", type: "tool" };
    const files = new Map<string, Uint8Array>();

    let caught: unknown;
    try {
      await cache.bundle({ files, manifest, toolId: "@t/no-entry" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleError);
    expect((caught as BundleError).code).toBe("TOOL_BUNDLE_FAILED");
    expect((caught as BundleError).message).toContain("entrypoint");
  });

  it("wraps bundler syntax errors as BundleError(TOOL_BUNDLE_FAILED)", async () => {
    const cache = new ToolBundleCache();
    const manifest = {
      name: "@t/syntax",
      version: "1.0.0",
      type: "tool",
      entrypoint: "tool.ts",
    };
    const files = new Map<string, Uint8Array>([
      ["tool.ts", enc("export default () => { this is not valid typescript")],
    ]);

    let caught: unknown;
    try {
      await cache.bundle({ files, manifest, toolId: "@t/syntax" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleError);
    expect((caught as BundleError).code).toBe("TOOL_BUNDLE_FAILED");
    expect((caught as BundleError).message).toContain("@t/syntax");
  });
});
