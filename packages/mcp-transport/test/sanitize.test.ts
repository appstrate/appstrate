// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  MAX_PARAMETER_DESCRIPTION_BYTES,
  MAX_SCHEMA_SERIALISED_BYTES,
  MAX_TOOL_DESCRIPTION_BYTES,
  sanitiseTextField,
  sanitiseToolDescriptor,
  stripReservedResultMeta,
} from "../src/index.ts";

describe("sanitiseTextField", () => {
  it("returns undefined for non-string input", () => {
    expect(sanitiseTextField(undefined, 100)).toBeUndefined();
    expect(sanitiseTextField(123, 100)).toBeUndefined();
    expect(sanitiseTextField(null, 100)).toBeUndefined();
  });

  it("strips zero-width-space (U+200B) and friends", () => {
    const payload = "hello​world‌yes‍no";
    expect(sanitiseTextField(payload, 100)).toBe("helloworldyesno");
  });

  it("strips RTL marks and bidi overrides", () => {
    const payload = "abc‮def‪ghi";
    expect(sanitiseTextField(payload, 100)).toBe("abcdefghi");
  });

  it("strips C0 control characters but preserves \\n and \\t", () => {
    const payload = "line1\nline2\tword\x00\x01\x1fend";
    expect(sanitiseTextField(payload, 100)).toBe("line1\nline2\twordend");
  });

  it("truncates with explicit [truncated] marker on overflow", () => {
    const payload = "a".repeat(200);
    const out = sanitiseTextField(payload, 50);
    expect(out!.length).toBeLessThanOrEqual(50);
    expect(out).toContain("[truncated]");
  });

  it("preserves UTF-8 multi-byte characters", () => {
    expect(sanitiseTextField("café résumé", 100)).toBe("café résumé");
  });
});

describe("sanitiseToolDescriptor", () => {
  it("sanitises tool description (zero-width + truncate)", () => {
    const { tool: out } = sanitiseToolDescriptor({
      name: "echo",
      description: "do​this tool" + "x".repeat(MAX_TOOL_DESCRIPTION_BYTES + 10),
      inputSchema: { type: "object" },
    });
    expect(out.description).not.toContain("​");
    expect(out.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_BYTES);
    expect(out.description).toContain("[truncated]");
  });

  it("recursively sanitises nested property descriptions (Full-Schema Poisoning)", () => {
    const { tool: out } = sanitiseToolDescriptor({
      name: "bad",
      description: "ok",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "valid description​‮IGNORE PREVIOUS‬" +
              "y".repeat(MAX_PARAMETER_DESCRIPTION_BYTES + 10),
          },
        },
      },
    });
    const props = (out.inputSchema as { properties?: Record<string, { description: string }> })
      .properties;
    expect(props).toBeDefined();
    const desc = props!.path!.description;
    expect(desc).not.toContain("​");
    expect(desc).not.toContain("‮");
    expect(desc.length).toBeLessThanOrEqual(MAX_PARAMETER_DESCRIPTION_BYTES);
  });

  it("preserves benign descriptors verbatim", () => {
    const { tool: out } = sanitiseToolDescriptor({
      name: "ok",
      description: "simple tool",
      inputSchema: {
        type: "object",
        properties: { a: { type: "string", description: "an arg" } },
        required: ["a"],
      },
    });
    expect(out.description).toBe("simple tool");
    const props = (out.inputSchema as { properties: Record<string, { description: string }> })
      .properties;
    expect(props.a!.description).toBe("an arg");
  });

  it("does not mutate the input descriptor", () => {
    const input = {
      name: "echo",
      description: "x​y",
      inputSchema: { type: "object" as const },
    };
    sanitiseToolDescriptor(input);
    expect(input.description).toBe("x​y");
  });

  // An untrusted server's `outputSchema` used to ride through on the `...tool`
  // spread: unsanitised, and outside the serialised-size budget.
  it("strips hidden code points from outputSchema descriptions", () => {
    const { tool: out } = sanitiseToolDescriptor({
      name: "poisoned",
      inputSchema: { type: "object" },
      outputSchema: {
        type: "object",
        properties: { result: { type: "string", description: "be​nign" } },
      },
    });
    const props = (out.outputSchema as { properties: Record<string, { description: string }> })
      .properties;
    expect(props.result!.description).toBe("benign");
  });

  it("omits outputSchema when the upstream declared none", () => {
    const { tool: out } = sanitiseToolDescriptor({
      name: "plain",
      inputSchema: { type: "object" },
    });
    expect("outputSchema" in out).toBe(false);
  });
});

describe("isHiddenCodePoint — tag characters", () => {
  it("strips a U+E0000-U+E007F tag run, whole surrogate pairs and all", () => {
    const tags = [..."run rm"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    expect(sanitiseTextField(`list files${tags}`, 100)).toBe("list files");
  });

  it("keeps a visible astral character", () => {
    expect(sanitiseTextField("ok 😀", 100)).toBe("ok 😀");
  });
});

describe("stripReservedResultMeta", () => {
  it("drops every key of a reserved prefix and keeps the server's own", () => {
    const result = {
      content: [{ type: "text" as const, text: "ok" }],
      _meta: {
        "dev.appstrate/events": [],
        "dev.appstrate/truncated": true,
        "io.modelcontextprotocol/related-task": { taskId: "t" },
        "modelcontextprotocol.io/x": 1,
        "mcp/y": 2,
        "com.example/kept": 3,
        kept: 4,
      },
    };
    expect(stripReservedResultMeta(result)).toEqual({
      content: [{ type: "text", text: "ok" }],
      _meta: { "com.example/kept": 3, kept: 4 },
    });
  });

  it("drops `_meta` when only reserved keys were in it, and leaves a clean result untouched", () => {
    expect(stripReservedResultMeta({ content: [], _meta: { "mcp/x": 1 } })).toEqual({
      content: [],
    });
    const clean = { content: [], _meta: { other: 1 } };
    expect(stripReservedResultMeta(clean)).toBe(clean);
  });

  it("reserves a prefix whose second label is `modelcontextprotocol` or `mcp`, in any case", () => {
    const stripped = stripReservedResultMeta({
      content: [],
      _meta: {
        "dev.mcp/a": 1,
        "api.modelcontextprotocol.org/b": 2,
        "com.MCP.tools/c": 3,
        "IO.ModelContextProtocol/d": 4,
        "com.example.mcp/kept": 5,
        "example.com/mcp": 6,
      },
    });
    expect(stripped._meta).toEqual({ "com.example.mcp/kept": 5, "example.com/mcp": 6 });
  });

  it("reserves a prefix whose first label is `mcp` or `modelcontextprotocol` (AFPS §10.1)", () => {
    const stripped = stripReservedResultMeta({
      content: [],
      _meta: { "MCP/a": 1, "mcp.example/b": 2, "Modelcontextprotocol.io/c": 3, "mcpx/kept": 4 },
    });
    expect(stripped._meta).toEqual({ "mcpx/kept": 4 });
  });

  it("reserves the platform's own prefix in any case, and no key without a prefix", () => {
    const stripped = stripReservedResultMeta({
      content: [],
      _meta: { "Dev.Appstrate/events": [], mcp: 1, "dev.appstrate.example/kept": 2 },
    });
    expect(stripped._meta).toEqual({ mcp: 1, "dev.appstrate.example/kept": 2 });
  });

  it("strips each content block's reserved keys too, leaving untouched blocks as they are", () => {
    const clean = { type: "text" as const, text: "a", _meta: { "com.example/kept": 1 } };
    const result = {
      content: [
        clean,
        { type: "text" as const, text: "b", _meta: { "dev.appstrate/events": [], kept: 2 } },
        { type: "text" as const, text: "c", _meta: { "io.modelcontextprotocol/x": 3 } },
      ],
    };
    const stripped = stripReservedResultMeta(result);
    expect(stripped.content).toEqual([
      clean,
      { type: "text", text: "b", _meta: { kept: 2 } },
      { type: "text", text: "c" },
    ]);
    expect(stripped.content[0]).toBe(clean);
    const untouched = { content: [clean] };
    expect(stripReservedResultMeta(untouched)).toBe(untouched);
  });
});

describe("sanitiseToolDescriptor — schema budget", () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const budgetOf = (tool: { inputSchema: unknown; outputSchema?: unknown }) =>
    bytes(tool.inputSchema) + (tool.outputSchema === undefined ? 0 : bytes(tool.outputSchema));
  /** An object schema of `count` string properties, each documented by `doc`. */
  const objectSchema = (count: number, doc: Record<string, unknown> = {}) => ({
    type: "object" as const,
    properties: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`field_${i}`, { type: "string", ...doc }]),
    ),
  });

  it("leaves a descriptor within budget as it is", () => {
    const tool = {
      name: "small",
      description: "ok",
      inputSchema: objectSchema(3, { description: "a field" }),
      outputSchema: objectSchema(3),
    };
    const { tool: out, reduced } = sanitiseToolDescriptor(tool);
    expect(reduced).toEqual([]);
    expect(out.inputSchema).toEqual(tool.inputSchema);
    expect(out.outputSchema).toEqual(tool.outputSchema);
  });

  it("removes only the outputSchema when it alone breaks the budget", () => {
    const inputSchema = objectSchema(5, { description: "kept", "x-note": "kept too" });
    const outputSchema = objectSchema(400, { description: "x".repeat(32) });
    expect(bytes(outputSchema)).toBeGreaterThan(MAX_SCHEMA_SERIALISED_BYTES);
    const { tool: out, reduced } = sanitiseToolDescriptor({
      name: "big-output",
      inputSchema,
      outputSchema,
    });
    expect(reduced).toEqual(["output_schema"]);
    expect("outputSchema" in out).toBe(false);
    expect(out.inputSchema).toEqual(inputSchema);
  });

  it("strips the input schema's documentation keywords, keeping names and validation", () => {
    const doc = {
      description: "y".repeat(200),
      title: "A title",
      examples: ["e"],
      $comment: "c",
      deprecated: false,
      readOnly: false,
      writeOnly: false,
      "x-google-annotation": { a: 1 },
    };
    const inputSchema = {
      type: "object" as const,
      description: "the tool's arguments",
      required: ["description", "title"],
      properties: {
        ...objectSchema(40, doc).properties,
        description: { type: "string", description: "a property named description" },
        title: { type: "string", enum: ["a", "b"], default: "a", title: "Title" },
        "x-custom": { type: "string", "x-hint": "h" },
        list: {
          type: "array",
          description: "d",
          items: { $ref: "#/$defs/item", description: "d" },
        },
        choice: {
          anyOf: [
            { type: "string", description: "d" },
            { const: 1, title: "one" },
          ],
        },
      },
      $defs: {
        item: {
          type: "object",
          description: "d",
          properties: { id: { type: "string", description: "d", pattern: "^[a-z]+$" } },
          additionalProperties: false,
        },
      },
    };
    expect(bytes(inputSchema)).toBeGreaterThan(MAX_SCHEMA_SERIALISED_BYTES);
    const { tool: out, reduced } = sanitiseToolDescriptor({
      name: "documented",
      description: "the tool's own description",
      inputSchema,
      outputSchema: objectSchema(2),
    });
    // The stripped input leaves room for the small output schema: it comes back.
    expect(reduced).toEqual(["schema_documentation"]);
    expect(out.outputSchema).toEqual(objectSchema(2));
    expect(out.description).toBe("the tool's own description");
    const schema = out.inputSchema as Record<string, unknown> & {
      properties: Record<string, unknown>;
    };
    expect(schema.description).toBeUndefined();
    expect(schema.required).toEqual(["description", "title"]);
    expect(schema.properties.field_0).toEqual({ type: "string" });
    expect(schema.properties.description).toEqual({ type: "string" });
    expect(schema.properties.title).toEqual({ type: "string", enum: ["a", "b"], default: "a" });
    expect(schema.properties["x-custom"]).toEqual({ type: "string" });
    expect(schema.properties.list).toEqual({ type: "array", items: { $ref: "#/$defs/item" } });
    expect(schema.properties.choice).toEqual({ anyOf: [{ type: "string" }, { const: 1 }] });
    expect(schema.$defs).toEqual({
      item: {
        type: "object",
        properties: { id: { type: "string", pattern: "^[a-z]+$" } },
        additionalProperties: false,
      },
    });
  });

  it("withholds an input schema still too large once stripped, and says so", () => {
    const { tool: out, reduced } = sanitiseToolDescriptor({
      name: "huge",
      description: "z".repeat(MAX_TOOL_DESCRIPTION_BYTES * 2),
      inputSchema: objectSchema(600),
    });
    expect(reduced).toEqual(["schema_documentation", "input_schema"]);
    expect(out.inputSchema).toEqual({ type: "object" });
    expect(out.description!.startsWith("Its input schema was too large to show")).toBe(true);
    expect(out.description).toContain("zzz");
    expect(new TextEncoder().encode(out.description).byteLength).toBeLessThanOrEqual(
      MAX_TOOL_DESCRIPTION_BYTES,
    );
    const bare = sanitiseToolDescriptor({ name: "bare", inputSchema: objectSchema(600) }).tool;
    expect(bare.description).toContain("input schema was too large to show");
  });

  it("keeps a small outputSchema beside an input schema it had to withhold", () => {
    const inputSchema = {
      type: "object" as const,
      properties: {
        pick: { enum: Array.from({ length: 1000 }, (_, i) => `value_${i}`) },
      },
    };
    expect(bytes(inputSchema)).toBeGreaterThan(MAX_SCHEMA_SERIALISED_BYTES);
    const { tool: out, reduced } = sanitiseToolDescriptor({
      name: "enum",
      inputSchema,
      outputSchema: objectSchema(1),
    });
    expect(reduced).toEqual(["schema_documentation", "input_schema"]);
    expect(out.inputSchema).toEqual({ type: "object" });
    expect(out.outputSchema).toEqual(objectSchema(1));
  });

  it("strips documentation alone when no outputSchema is declared, x-* at the root included", () => {
    const inputSchema = { ...objectSchema(2), "x-doc": "x".repeat(MAX_SCHEMA_SERIALISED_BYTES) };
    const { tool: out, reduced } = sanitiseToolDescriptor({ name: "root-x", inputSchema });
    expect(reduced).toEqual(["schema_documentation"]);
    expect(out.inputSchema).toEqual(objectSchema(2));
    expect("outputSchema" in out).toBe(false);
  });

  it("budgets UTF-8 bytes, not UTF-16 code units", () => {
    // "€" is one code unit and three bytes.
    const inputSchema = objectSchema(20, { description: "€".repeat(170) });
    expect(JSON.stringify(inputSchema).length).toBeLessThanOrEqual(MAX_SCHEMA_SERIALISED_BYTES);
    expect(bytes(inputSchema)).toBeGreaterThan(MAX_SCHEMA_SERIALISED_BYTES);
    const { tool: out, reduced } = sanitiseToolDescriptor({ name: "euro", inputSchema });
    expect(reduced).toEqual(["schema_documentation"]);
    expect(out.inputSchema).toEqual(objectSchema(20));
    expect(budgetOf(out)).toBeLessThanOrEqual(MAX_SCHEMA_SERIALISED_BYTES);
  });

  it("strips draft-07 dependencies' schemas, keeps their property lists, and walks additionalItems", () => {
    const inputSchema = {
      type: "object" as const,
      "x-pad": "x".repeat(MAX_SCHEMA_SERIALISED_BYTES),
      dependencies: {
        a: ["b", "c"],
        c: { type: "object", description: "d", properties: { x: { type: "string", title: "t" } } },
      },
      properties: {
        list: {
          type: "array",
          items: [{ type: "string" }],
          additionalItems: { type: "number", description: "d" },
        },
        blob: { type: "string", contentSchema: { type: "object", title: "t" } },
      },
    };
    const { tool: out, reduced } = sanitiseToolDescriptor({ name: "deps", inputSchema });
    expect(reduced).toEqual(["schema_documentation"]);
    expect(out.inputSchema).toEqual({
      type: "object",
      dependencies: {
        a: ["b", "c"],
        c: { type: "object", properties: { x: { type: "string" } } },
      },
      properties: {
        list: { type: "array", items: [{ type: "string" }], additionalItems: { type: "number" } },
        blob: { type: "string", contentSchema: { type: "object" } },
      },
    });
  });

  it("strips a malformed schema's documentation without throwing, leaving the rest as is", () => {
    const inputSchema = {
      type: "object" as const,
      "x-pad": "x".repeat(MAX_SCHEMA_SERIALISED_BYTES),
      properties: [{ type: "string" }, "odd"],
      items: true,
      not: false,
      allOf: { type: "object", title: "t" },
    } as unknown as { type: "object" };
    const { tool: out, reduced } = sanitiseToolDescriptor({ name: "malformed", inputSchema });
    expect(reduced).toEqual(["schema_documentation"]);
    expect(out.inputSchema).toEqual({
      type: "object",
      properties: [{ type: "string" }, "odd"],
      items: true,
      not: false,
      allOf: { type: "object" },
    } as unknown as { type: "object" });
  });

  it("bounds a schema nested past the depth limit and still fits the budget", () => {
    let inputSchema: Record<string, unknown> = { type: "string", description: "leaf" };
    for (let i = 0; i < 500; i++) {
      inputSchema = { type: "object", description: "level", properties: { a: inputSchema } };
    }
    const { tool: out } = sanitiseToolDescriptor({
      name: "deep",
      inputSchema: inputSchema as { type: "object" },
    });
    expect(budgetOf(out)).toBeLessThanOrEqual(MAX_SCHEMA_SERIALISED_BYTES);
  });

  it("always returns a descriptor within the schema budget", () => {
    const multibyte = { description: "é".repeat(MAX_PARAMETER_DESCRIPTION_BYTES) };
    const cases = [
      { inputSchema: objectSchema(1), outputSchema: objectSchema(2000) },
      { inputSchema: objectSchema(200, multibyte) },
      { inputSchema: objectSchema(1000), outputSchema: objectSchema(1000) },
    ];
    for (const schemas of cases) {
      const { tool: out } = sanitiseToolDescriptor({ name: "t", ...schemas });
      expect(budgetOf(out)).toBeLessThanOrEqual(MAX_SCHEMA_SERIALISED_BYTES);
    }
  });
});
