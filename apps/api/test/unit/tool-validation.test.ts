// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { validateToolSource } from "@appstrate/core/validation";

// --- Fixtures ---

const VALID_TOOL = `
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    description: "Does something",
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, params, signal) {
      return { content: [{ type: "text", text: "hello" }] };
    },
  });
}
`;

const VALID_TOOL_TWO_PARAMS = `
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    description: "Does something",
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: "hello" }] };
    },
  });
}
`;

const WRONG_SIGNATURE_ONE_PARAM = `
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    description: "Does something",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      return { content: [{ type: "text", text: args.input }] };
    },
  });
}
`;

const NO_EXPORT_DEFAULT = `
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function setup(pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    description: "Does something",
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, params, signal) {
      return { content: [{ type: "text", text: "hello" }] };
    },
  });
}
`;

const NO_REGISTER_TOOL = `
export default function(pi: any) {
  console.log("no tool registered");
}
`;

const UNBALANCED_BRACES = `
export default function(pi: any) {
  pi.registerTool({
    name: "broken",
    async execute(_toolCallId, params, signal) {
      return { content: [{ type: "text", text: "hello" }] };
    },
  });
`;

const COMPLEX_TS_TYPES = `
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "complex_tool",
    description: "Uses complex TS types",
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId: string, params: Record<string, unknown>, signal: AbortSignal) {
      const data: Map<string, Array<number>> = new Map();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  });
}
`;

const TYPEBOX_PARAMS = `
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "typebox_tool",
    parameters: Type.Object({
      url: Type.String({ description: "URL" }),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
    async execute(_toolCallId, params, signal) {
      return { content: [{ type: "text" as const, text: params.url }] };
    },
  });
}
`;

// =====================================================
// validateToolSource
// =====================================================

describe("validateToolSource", () => {
  it("accepts a valid tool with 3 params", () => {
    const result = validateToolSource(VALID_TOOL);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts a valid tool with 2 params (no signal)", () => {
    const result = validateToolSource(VALID_TOOL_TWO_PARAMS);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("rejects execute(args) with 1 param", () => {
    const result = validateToolSource(WRONG_SIGNATURE_ONE_PARAM);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("execute"))).toBe(true);
    expect(result.errors.some((e) => e.includes("toolCallId"))).toBe(true);
  });

  it("rejects missing export default", () => {
    const result = validateToolSource(NO_EXPORT_DEFAULT);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("export default"))).toBe(true);
  });

  it("warns when registerTool is not called", () => {
    const result = validateToolSource(NO_REGISTER_TOOL);
    expect(result.valid).toBe(true); // warning only, not blocking
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("registerTool"))).toBe(true);
  });

  it("rejects empty content", () => {
    const result = validateToolSource("");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("empty"))).toBe(true);
  });

  it("rejects whitespace-only content", () => {
    const result = validateToolSource("   \n\t  ");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("empty"))).toBe(true);
  });

  it("does not reject unbalanced braces (naive check removed — false positives)", () => {
    const result = validateToolSource(UNBALANCED_BRACES);
    // Brace counting was removed: it produced false positives on template literals and strings
    expect(result.valid).toBe(true);
  });

  it("handles complex TS types without false positives on param count", () => {
    const result = validateToolSource(COMPLEX_TS_TYPES);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("handles Typebox parameters without issues", () => {
    const result = validateToolSource(TYPEBOX_PARAMS);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("warns about missing content: return format", () => {
    const source = `
export default function(pi: any) {
  pi.registerTool({
    name: "tool",
    async execute(_toolCallId, params, signal) {
      return "just a string";
    },
  });
}
`;
    const result = validateToolSource(source);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("content"))).toBe(true);
  });

  it("line comments do not affect execute param counting", () => {
    const source = `
export default function(pi: any) {
  pi.registerTool({
    name: "tool",
    // execute(singleParam) — this comment should be ignored
    async execute(_toolCallId, params, signal) {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
}
`;
    const result = validateToolSource(source);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("multiple errors can be reported at once", () => {
    const source = `
function broken(pi: any) {
  pi.registerTool({
    name: "tool",
    async execute(args) {
      return "bad";
    },
  })
`;
    const result = validateToolSource(source);
    expect(result.valid).toBe(false);
    // Should have: no export default + 1-param execute + unbalanced braces
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
