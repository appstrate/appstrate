import { describe, test, expect } from "bun:test";
import { validateExtensionSource } from "../extension-validation.ts";

// --- Fixtures ---

const VALID_EXTENSION = `
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

const VALID_EXTENSION_TWO_PARAMS = `
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
// validateExtensionSource
// =====================================================

describe("validateExtensionSource", () => {
  test("accepts a valid extension with 3 params", () => {
    const result = validateExtensionSource(VALID_EXTENSION);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("accepts a valid extension with 2 params (no signal)", () => {
    const result = validateExtensionSource(VALID_EXTENSION_TWO_PARAMS);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("rejects execute(args) with 1 param", () => {
    const result = validateExtensionSource(WRONG_SIGNATURE_ONE_PARAM);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("execute"))).toBe(true);
    expect(result.errors.some((e) => e.includes("toolCallId"))).toBe(true);
  });

  test("rejects missing export default", () => {
    const result = validateExtensionSource(NO_EXPORT_DEFAULT);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("export default"))).toBe(true);
  });

  test("warns when registerTool is not called", () => {
    const result = validateExtensionSource(NO_REGISTER_TOOL);
    expect(result.valid).toBe(true); // warning only, not blocking
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("registerTool"))).toBe(true);
  });

  test("rejects empty content", () => {
    const result = validateExtensionSource("");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("vide"))).toBe(true);
  });

  test("rejects whitespace-only content", () => {
    const result = validateExtensionSource("   \n\t  ");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("vide"))).toBe(true);
  });

  test("rejects unbalanced braces", () => {
    const result = validateExtensionSource(UNBALANCED_BRACES);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("accolades"))).toBe(true);
  });

  test("handles complex TS types without false positives on param count", () => {
    const result = validateExtensionSource(COMPLEX_TS_TYPES);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("handles Typebox parameters without issues", () => {
    const result = validateExtensionSource(TYPEBOX_PARAMS);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("warns about missing content: return format", () => {
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
    const result = validateExtensionSource(source);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("content"))).toBe(true);
  });

  test("line comments do not affect execute param counting", () => {
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
    const result = validateExtensionSource(source);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("multiple errors can be reported at once", () => {
    const source = `
function broken(pi: any) {
  pi.registerTool({
    name: "tool",
    async execute(args) {
      return "bad";
    },
  })
`;
    const result = validateExtensionSource(source);
    expect(result.valid).toBe(false);
    // Should have: no export default + 1-param execute + unbalanced braces
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
