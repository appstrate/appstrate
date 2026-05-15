// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Contract tests for the runtime-injected-tool descriptor list.
 *
 * The list is the single source of truth consumed by:
 *   - `runtime-pi/mcp/direct.ts` to register Pi tools that forward to MCP
 *   - `apps/api/services/run-launcher/prompt-builder.ts` to extend
 *     `availableTools` and `toolDocs` on the platform prompt — `TOOL.md`
 *     is loaded via `loadRuntimeToolDoc`, mirroring how bundle tools
 *     expose their doc through `pkg.files.get("TOOL.md")`.
 *
 * The tests below lock the descriptor's invariants so that adding a new
 * entry to the list (the documented extension point) requires zero
 * changes elsewhere — the registration loop and prompt-builder flow
 * pick it up by iteration.
 */

import { describe, it, expect } from "bun:test";
import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECALL_MEMORY_INJECTED_TOOL,
  RUN_HISTORY_INJECTED_TOOL,
  RUNTIME_INJECTED_TOOLS,
  loadRuntimeToolDoc,
  type RuntimeInjectedTool,
} from "../src/runtime-tools/index.ts";
import { defineTool } from "../src/runtime-tools/define.ts";

const RUNTIME_TOOLS_DIR = fileURLToPath(new URL("../src/runtime-tools/", import.meta.url));

describe("RUNTIME_INJECTED_TOOLS", () => {
  it("includes both run_history and recall_memory in canonical order", () => {
    expect(RUNTIME_INJECTED_TOOLS).toEqual([
      RUN_HISTORY_INJECTED_TOOL,
      RECALL_MEMORY_INJECTED_TOOL,
    ]);
  });

  it("each descriptor has all the fields consumers expect", () => {
    for (const tool of RUNTIME_INJECTED_TOOLS) {
      // Required by the platform prompt builder + Pi registration.
      expect(typeof tool.id).toBe("string");
      expect(tool.id.length).toBeGreaterThan(0);
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      // Required by the MCP-forwarding factory in runtime-pi/mcp/direct.ts.
      expect(typeof tool.parameters).toBe("object");
      expect(tool.parameters).not.toBeNull();
      // Required by the platform prompt builder to locate the co-located TOOL.md.
      expect(tool.dirUrl).toBeInstanceOf(URL);
      expect(tool.dirUrl.pathname.endsWith("/")).toBe(true);
    }
  });

  it("descriptors do NOT carry a `doc` field — TOOL.md is platform-resolved", () => {
    // Locality contract: doc strings live in TOOL.md, never inlined
    // into the descriptor module. Mirrors bundle tools, where
    // `pkg.files.get("TOOL.md")` is the only doc resolution path.
    for (const tool of RUNTIME_INJECTED_TOOLS) {
      expect((tool as { doc?: unknown }).doc).toBeUndefined();
    }
  });

  it("parameters are JSON-Schema objects (no Pi-AI / typebox imports leaking)", () => {
    // The descriptor is consumed both by runtime-pi (where Pi types
    // are available) and by apps/api (where they aren't). Keeping
    // parameters as plain JSON Schema guarantees this module stays
    // import-light. Pi wraps it with `Type.Unsafe(schema)` at
    // registration time.
    for (const tool of RUNTIME_INJECTED_TOOLS) {
      const params = tool.parameters as Record<string, unknown>;
      expect(params.type).toBe("object");
      expect(typeof params.properties).toBe("object");
    }
  });

  it("ids and names are unique across the list (no shadowing)", () => {
    const ids = RUNTIME_INJECTED_TOOLS.map((t) => t.id);
    const names = RUNTIME_INJECTED_TOOLS.map((t) => t.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("the descriptor type is structurally sufficient for both consumers", () => {
    // Compile-time check that the public type exposes what consumers
    // need. If a consumer adds a required field, the build breaks here
    // first instead of in the consumer file.
    const _exhaustive: RuntimeInjectedTool = defineTool(import.meta, {
      id: "x",
      name: "x",
      description: "x",
      parameters: { type: "object", properties: {} },
    });
    expect(_exhaustive.name).toBe("x");
    expect(_exhaustive.dirUrl).toBeInstanceOf(URL);
  });
});

describe("runtime-tools directory layout", () => {
  // Each runtime-injected tool lives in its own directory under
  // `runtime-tools/`, mirroring the bundle-tool layout
  // (`scripts/system-packages/tool-<name>-<version>/`). These tests
  // verify the directory contract so refactors keep the SOC promise.

  it("each tool has its own directory with `tool.ts` + `TOOL.md`", async () => {
    const entries = await readdir(RUNTIME_TOOLS_DIR, { withFileTypes: true });
    const toolDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    // One directory per registered tool. If a directory exists without
    // a corresponding entry in `RUNTIME_INJECTED_TOOLS`, fail loudly —
    // it's either a leftover from a deleted tool or a forgotten import.
    expect(toolDirs.length).toBe(RUNTIME_INJECTED_TOOLS.length);

    for (const dir of toolDirs) {
      const toolFile = join(RUNTIME_TOOLS_DIR, dir, "tool.ts");
      const docFile = join(RUNTIME_TOOLS_DIR, dir, "TOOL.md");
      await expect(stat(toolFile)).resolves.toBeDefined();
      await expect(stat(docFile)).resolves.toBeDefined();
    }
  });

  it("every descriptor's `dirUrl` points at an existing directory under runtime-tools/", () => {
    // Sanity check that `defineTool(import.meta, …)` captured a real
    // path. If a tool.ts is moved without updating the directory
    // structure, this fails before the consumer ever touches TOOL.md.
    for (const tool of RUNTIME_INJECTED_TOOLS) {
      const dirPath = fileURLToPath(tool.dirUrl);
      expect(dirPath.startsWith(RUNTIME_TOOLS_DIR)).toBe(true);
    }
  });
});

describe("loadRuntimeToolDoc", () => {
  // The platform-side loader mirrors bundle tools' `pkg.files.get(
  // "TOOL.md")`: a single resolution point that reads the co-located
  // file at call time. The descriptor itself stays doc-free; the
  // loader resolves `TOOL.md` from each tool's `dirUrl`, which was
  // captured at module load by `defineTool(import.meta, …)`.

  it("returns the exact bytes of the TOOL.md sitting in each tool's directory", async () => {
    for (const tool of RUNTIME_INJECTED_TOOLS) {
      const docPath = join(fileURLToPath(tool.dirUrl), "TOOL.md");
      const fileContent = await readFile(docPath, "utf8");
      expect(loadRuntimeToolDoc(tool)).toBe(fileContent);
    }
  });

  it("returned content starts with `## <tool_name>` (visual parity with bundle docs)", () => {
    // The TOOL.md convention is `## tool_name`, so doc fragments
    // rendered alongside bundle TOOL.mds match visually.
    for (const tool of RUNTIME_INJECTED_TOOLS) {
      expect(loadRuntimeToolDoc(tool)).toMatch(new RegExp(`^## ${tool.name}\\b`));
    }
  });
});
