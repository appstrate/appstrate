// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Contract tests for the runtime-injected-tool descriptor list.
 *
 * The list is the single source of truth consumed by
 * `runtime-pi/mcp/direct.ts` to register Pi tools that forward to the
 * sidecar over MCP. Each descriptor is pure metadata (name + description +
 * parameter schema); the `description` is the LLM-facing doc, surfaced via
 * MCP `tools/list` — there is no co-located TOOL.md and no prompt injection.
 */

import { describe, it, expect } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_BROWSER_INJECTED_TOOL,
  RECALL_MEMORY_INJECTED_TOOL,
  RUN_HISTORY_INJECTED_TOOL,
  RUNTIME_INJECTED_TOOLS,
  type RuntimeInjectedTool,
} from "../src/runtime-tools/index.ts";
import { defineTool } from "../src/runtime-tools/define.ts";

const RUNTIME_TOOLS_DIR = fileURLToPath(new URL("../src/runtime-tools/", import.meta.url));

describe("RUNTIME_INJECTED_TOOLS", () => {
  it("includes run_history, recall_memory and desktop_browser in canonical order", () => {
    expect(RUNTIME_INJECTED_TOOLS).toEqual([
      RUN_HISTORY_INJECTED_TOOL,
      RECALL_MEMORY_INJECTED_TOOL,
      DESKTOP_BROWSER_INJECTED_TOOL,
    ]);
  });

  it("each descriptor has all the fields consumers expect", () => {
    for (const tool of RUNTIME_INJECTED_TOOLS) {
      expect(typeof tool.id).toBe("string");
      expect(tool.id.length).toBeGreaterThan(0);
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      // The description IS the LLM-facing doc (advertised via tools/list).
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      // Required by the MCP-forwarding factory in runtime-pi/mcp/direct.ts.
      expect(typeof tool.parameters).toBe("object");
      expect(tool.parameters).not.toBeNull();
    }
  });

  it("descriptors carry neither `doc` nor `dirUrl` — no prompt-side doc machinery", () => {
    for (const tool of RUNTIME_INJECTED_TOOLS) {
      expect((tool as { doc?: unknown }).doc).toBeUndefined();
      expect((tool as { dirUrl?: unknown }).dirUrl).toBeUndefined();
    }
  });

  it("parameters are JSON-Schema objects (no Pi-AI / typebox imports leaking)", () => {
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

  it("defineTool is an identity over the descriptor", () => {
    const t: RuntimeInjectedTool = defineTool({
      id: "x",
      name: "x",
      description: "x",
      parameters: { type: "object", properties: {} },
    });
    expect(t.name).toBe("x");
  });
});

describe("runtime-tools directory layout", () => {
  it("each injected tool has its own directory with `tool.ts` (no TOOL.md)", async () => {
    const entries = await readdir(RUNTIME_TOOLS_DIR, { withFileTypes: true });
    // `builtin/` holds the in-process built-in runtime tools (output/log/
    // note/pin/report) — not MCP-forwarding injected tools, so it's excluded.
    const toolDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => name !== "builtin");

    // One directory per registered tool.
    expect(toolDirs.length).toBe(RUNTIME_INJECTED_TOOLS.length);

    for (const dir of toolDirs) {
      await expect(stat(join(RUNTIME_TOOLS_DIR, dir, "tool.ts"))).resolves.toBeDefined();
      // TOOL.md is gone — the description on the descriptor is the doc.
      await expect(stat(join(RUNTIME_TOOLS_DIR, dir, "TOOL.md"))).rejects.toBeDefined();
    }
  });
});
