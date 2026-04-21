// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  BundledToolResolver,
  BundledSkillResolver,
  BundledToolResolutionError,
  BundledSkillResolutionError,
  toBundle,
  type Bundle,
  type Tool,
} from "../../src/resolvers/index.ts";

/** Minimal in-memory bundle suitable for resolver unit tests. */
function makeBundle(entries: Record<string, string | Uint8Array>): Bundle {
  const files: Record<string, Uint8Array> = {};
  const enc = new TextEncoder();
  for (const [key, value] of Object.entries(entries)) {
    files[key] = typeof value === "string" ? enc.encode(value) : value;
  }
  return toBundle({
    manifest: {},
    prompt: "",
    files,
    compressedSize: 0,
    decompressedSize: 0,
  });
}

describe("BundledToolResolver", () => {
  it("throws BundledToolResolutionError when no entrypoint exists", async () => {
    const bundle = makeBundle({});
    const resolver = new BundledToolResolver();
    await expect(
      resolver.resolve([{ name: "@afps/memory", version: "^1" }], bundle),
    ).rejects.toBeInstanceOf(BundledToolResolutionError);
  });

  it("materialises a tool from a captured import (test seam)", async () => {
    const bundle = makeBundle({
      ".agent-package/tools/@afps/memory/index.js": "// stub — loader bypassed via importModule",
    });
    const fake: Tool = {
      name: "add_memory",
      description: "stub",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const resolver = new BundledToolResolver({
      importModule: async () => fake,
    });
    const tools = await resolver.resolve([{ name: "@afps/memory", version: "^1" }], bundle);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("add_memory");
  });

  it("rejects tool exports missing required fields", async () => {
    const bundle = makeBundle({
      ".agent-package/tools/@afps/bad/index.js": "// stub",
    });
    const resolver = new BundledToolResolver({
      // Missing execute → materialiseTool succeeds but validateTool should reject.
      importModule: async () => ({ name: "bad", description: "x", parameters: {} }) as Tool,
    });
    await expect(
      resolver.resolve([{ name: "@afps/bad", version: "^1" }], bundle),
    ).rejects.toBeInstanceOf(BundledToolResolutionError);
  });
});

describe("BundledSkillResolver", () => {
  it("loads SKILL.md and parses frontmatter", async () => {
    const bundle = makeBundle({
      ".agent-package/skills/@acme/recon/SKILL.md":
        "---\nname: recon\ndescription: Look around\n---\n\n# Body\n",
    });
    const resolver = new BundledSkillResolver();
    const out = await resolver.resolve([{ name: "@acme/recon", version: "^1" }], bundle);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("@acme/recon");
    expect(out[0]!.content.trim()).toContain("# Body");
    expect(out[0]!.frontmatter).toEqual({ name: "recon", description: "Look around" });
  });

  it("throws BundledSkillResolutionError when file missing", async () => {
    const resolver = new BundledSkillResolver();
    await expect(
      resolver.resolve([{ name: "@acme/missing", version: "^1" }], makeBundle({})),
    ).rejects.toBeInstanceOf(BundledSkillResolutionError);
  });
});

describe("toBundle", () => {
  it("resolves read/readText/exists against the sanitized file map", async () => {
    const bundle = toBundle({
      manifest: {},
      prompt: "",
      files: { "foo.txt": new TextEncoder().encode("bar") },
      compressedSize: 0,
      decompressedSize: 0,
    });
    expect(await bundle.exists("foo.txt")).toBe(true);
    expect(await bundle.exists("missing.txt")).toBe(false);
    expect(await bundle.readText("foo.txt")).toBe("bar");
    const bytes = await bundle.read("foo.txt");
    expect(new TextDecoder().decode(bytes)).toBe("bar");
  });

  it("computes a stable digest that changes when file contents change", async () => {
    const a = toBundle({
      manifest: {},
      prompt: "",
      files: { "a.txt": new TextEncoder().encode("x") },
      compressedSize: 0,
      decompressedSize: 0,
    });
    const b = toBundle({
      manifest: {},
      prompt: "",
      files: { "a.txt": new TextEncoder().encode("y") },
      compressedSize: 0,
      decompressedSize: 0,
    });
    expect(a.digest).not.toBe(b.digest);
  });
});
