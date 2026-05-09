// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Contract tests for the runtime-injected-tool descriptor list.
 *
 * The list is the single source of truth consumed by:
 *   - `runtime-pi/mcp/direct.ts` to register Pi tools that forward to MCP
 *   - `apps/api/services/adapters/prompt-builder.ts` to extend
 *     `availableTools` and `toolDocs` on the platform prompt
 *
 * The tests below lock the descriptor's invariants so that adding a new
 * entry to the list (the documented extension point) requires zero
 * changes elsewhere — the registration loop and prompt-builder flow
 * pick it up by iteration.
 */

import { describe, it, expect } from "bun:test";
import {
  RECALL_MEMORY_INJECTED_TOOL,
  RUN_HISTORY_INJECTED_TOOL,
  RUNTIME_INJECTED_TOOLS,
  type RuntimeInjectedTool,
} from "../src/runtime-injected-tools.ts";

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
      // Required so the LLM learns the calling convention from the prompt.
      expect(typeof tool.doc).toBe("string");
      expect(tool.doc.length).toBeGreaterThan(0);
    }
  });

  it("doc fragments start with a level-2 markdown heading matching the tool name", () => {
    // The TOOL.md convention is `## tool_name`, so doc fragments
    // rendered alongside bundle TOOL.mds match visually.
    for (const tool of RUNTIME_INJECTED_TOOLS) {
      expect(tool.doc).toMatch(new RegExp(`^## ${tool.name}\\b`));
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
    const _exhaustive: RuntimeInjectedTool = {
      id: "x",
      name: "x",
      description: "x",
      parameters: { type: "object", properties: {} },
      doc: "## x",
    };
    expect(_exhaustive.name).toBe("x");
  });
});
