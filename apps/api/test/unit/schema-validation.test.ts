import { describe, it, expect } from "bun:test";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { validateManifest } from "@appstrate/core/validation";
import { validateConfig, validateInput, validateOutput, validateFlowContent } from "../../src/services/schema.ts";

// --- Fixtures ---

const VALID_MANIFEST = {
  schemaVersion: "1.0",
  name: "@test-org/test-flow",
  version: "1.0.0",
  type: "flow",
  displayName: "Test Flow",
  description: "A test flow",
  author: "test",
  dependencies: {
    providers: { "@appstrate/gmail": "1.0.0" },
    skills: { "@appstrate/greeting-style": "*" },
    tools: { "@appstrate/web-search": "*" },
  },
  config: {
    schema: {
      type: "object",
      properties: {
        max_emails: { type: "number", default: 20, description: "Max emails" },
        language: { type: "string", default: "fr", enum: ["fr", "en"], description: "Language" },
      },
      required: [],
    },
  },
  input: {
    schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Search topic", placeholder: "ex: AI" },
      },
      required: ["topic"],
    },
  },
  output: {
    schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Result summary" },
        count: { type: "number", description: "Item count" },
      },
      required: ["summary", "count"],
    },
  },
  state: {
    enabled: true,
    schema: {
      type: "object",
      properties: {
        last_run: { type: "string", format: "date-time" },
      },
    },
  },
  timeout: 300,
};

const CONFIG_SCHEMA: JSONSchemaObject = {
  type: "object",
  properties: {
    max_emails: { type: "number", default: 20, description: "Max emails" },
    clickup_list_id: { type: "string", description: "ClickUp list ID" },
    language: { type: "string", default: "fr", enum: ["fr", "en"], description: "Language" },
  },
  required: ["clickup_list_id"],
};

const INPUT_SCHEMA: JSONSchemaObject = {
  type: "object",
  properties: {
    topic: { type: "string", description: "Search topic" },
    max_results: { type: "number", description: "Max results" },
  },
  required: ["topic"],
};

const OUTPUT_SCHEMA: JSONSchemaObject = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Summary text" },
    count: { type: "number", description: "Item count" },
    tags: { type: "array", description: "Tags list" },
  },
  required: ["summary", "count"],
};

// =====================================================
// validateManifest
// =====================================================

describe("validateManifest", () => {
  it("accepts a valid manifest with JSON Schema format", () => {
    const result = validateManifest(VALID_MANIFEST);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest).toBeDefined();
  });

  it("accepts manifest without optional sections (input, output, state)", () => {
    const minimal = {
      schemaVersion: "1.0",
      name: "@test-org/minimal",
      version: "1.0.0",
      type: "flow",
      displayName: "Minimal",
      description: "Minimal flow",
      author: "test",
      dependencies: { providers: {} },
    };
    const result = validateManifest(minimal);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts manifest with empty config schema", () => {
    const manifest = {
      ...VALID_MANIFEST,
      config: { schema: { type: "object", properties: {} } },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });

  it("rejects manifest with invalid name (not a slug)", () => {
    const bad = {
      ...VALID_MANIFEST,
      name: "Invalid Name!",
    };
    const result = validateManifest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("name");
  });

  it("rejects manifest missing required fields", () => {
    const bad = {
      schemaVersion: "1.0",
      name: "@test-org/test",
      version: "1.0.0",
      type: "flow",
      dependencies: { providers: {} },
    };
    const result = validateManifest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects old-format schema (flat record without type: object)", () => {
    const oldFormat = {
      ...VALID_MANIFEST,
      config: {
        schema: {
          max_emails: { type: "number", default: 20, required: false },
          clickup_list_id: { type: "string", required: true },
        },
      },
    };
    const result = validateManifest(oldFormat);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects invalid field type in schema properties", () => {
    const bad = {
      ...VALID_MANIFEST,
      config: {
        schema: {
          type: "object",
          properties: {
            field: { type: "invalid-type", description: "Bad" },
          },
        },
      },
    };
    const result = validateManifest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("type"))).toBe(true);
  });

  it("accepts custom placeholder property in schema", () => {
    const manifest = {
      ...VALID_MANIFEST,
      input: {
        schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search", placeholder: "Type here..." },
          },
          required: ["query"],
        },
      },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });

  it("accepts required as an array of strings on schema level", () => {
    const manifest = {
      ...VALID_MANIFEST,
      config: {
        schema: {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "number" },
          },
          required: ["a"],
        },
      },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });
});

// =====================================================
// validateConfig
// =====================================================

describe("validateConfig", () => {
  it("valid config passes", () => {
    const data = { max_emails: 20, clickup_list_id: "abc123", language: "fr" };
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("missing required field fails", () => {
    const data = { max_emails: 20, language: "fr" }; // missing clickup_list_id
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.field === "clickup_list_id")).toBe(true);
  });

  it("type coercion: string to number", () => {
    const data = { max_emails: "50", clickup_list_id: "abc123", language: "fr" };
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(true);
  });

  it("enum violation fails", () => {
    const data = { clickup_list_id: "abc", language: "de" }; // "de" not in enum
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "language")).toBe(true);
  });

  it("empty schema always passes", () => {
    const emptySchema: JSONSchemaObject = { type: "object", properties: {} };
    const result = validateConfig({ anything: "goes" }, emptySchema);
    expect(result.valid).toBe(true);
  });

  it("extra fields are accepted (no additionalProperties restriction by default)", () => {
    const data = { clickup_list_id: "abc123", extra_field: "hello" };
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(true);
  });

  it("wrong type without coercion possibility fails", () => {
    const data = { clickup_list_id: "abc", max_emails: "not-a-number" };
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "max_emails")).toBe(true);
  });

  it("empty string on required field fails (aligned with frontend)", () => {
    const data = { clickup_list_id: "", max_emails: 20 };
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "clickup_list_id")).toBe(true);
  });

  it("empty string on optional field is accepted", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        name: { type: "string" },
        notes: { type: "string" },
      },
      required: ["name"],
    };
    const data = { name: "test", notes: "" };
    const result = validateConfig(data, schema);
    // notes is not in required, so "" is kept and valid
    expect(result.valid).toBe(true);
  });

  it("schema without required array treats all fields as optional", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    };
    const result = validateConfig({}, schema);
    expect(result.valid).toBe(true);
  });
});

// =====================================================
// validateInput
// =====================================================

describe("validateInput", () => {
  it("valid input passes", () => {
    const result = validateInput({ topic: "AI", max_results: 10 }, INPUT_SCHEMA);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("missing required field fails", () => {
    const result = validateInput({ max_results: 10 }, INPUT_SCHEMA); // missing topic
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "topic")).toBe(true);
  });

  it("undefined input with required fields fails", () => {
    const result = validateInput(undefined, INPUT_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "topic")).toBe(true);
  });

  it("undefined input with no required fields passes", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { optional: { type: "string" } },
    };
    const result = validateInput(undefined, schema);
    expect(result.valid).toBe(true);
  });

  it("empty schema always passes", () => {
    const emptySchema: JSONSchemaObject = { type: "object", properties: {} };
    const result = validateInput(undefined, emptySchema);
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({});
  });

  it("type coercion: string to number for input", () => {
    const result = validateInput({ topic: "AI", max_results: "5" }, INPUT_SCHEMA);
    expect(result.valid).toBe(true);
  });

  it("schema with unknown keyword does not throw", () => {
    const schema = {
      type: "object",
      properties: {
        topic: { type: "string", description: "Search topic", customKeyword: "ignored" },
      },
      required: ["topic"],
    } as unknown as JSONSchemaObject;
    expect(() => validateInput({ topic: "AI" }, schema)).not.toThrow();
    const result = validateInput({ topic: "AI" }, schema);
    expect(result.valid).toBe(true);
  });
});

// =====================================================
// validateConfig (with custom keywords)
// =====================================================

describe("validateConfig with unknown keywords", () => {
  it("schema with unknown keyword does not throw", () => {
    const schema = {
      type: "object",
      properties: {
        api_key: { type: "string", description: "API key", customKeyword: "ignored" },
      },
      required: ["api_key"],
    } as unknown as JSONSchemaObject;
    expect(() => validateConfig({ api_key: "sk-123" }, schema)).not.toThrow();
    const result = validateConfig({ api_key: "sk-123" }, schema);
    expect(result.valid).toBe(true);
  });
});

// =====================================================
// validateOutput
// =====================================================

describe("validateOutput", () => {
  it("valid output passes", () => {
    const result = validateOutput({ summary: "Done", count: 5, tags: ["a"] }, OUTPUT_SCHEMA);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("missing required field fails", () => {
    const result = validateOutput({ summary: "Done" }, OUTPUT_SCHEMA); // missing count
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e: string) => e.includes("count"))).toBe(true);
  });

  it("extra fields are allowed (additionalProperties: true)", () => {
    const result = validateOutput(
      { summary: "Done", count: 5, state: { last_run: "2024-01-01" }, tokensUsed: 1234 },
      OUTPUT_SCHEMA,
    );
    expect(result.valid).toBe(true);
  });

  it("wrong type on required field fails", () => {
    const result = validateOutput({ summary: "Done", count: "not-a-number" }, OUTPUT_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("count"))).toBe(true);
  });

  it("missing optional field is OK", () => {
    const result = validateOutput({ summary: "Done", count: 5 }, OUTPUT_SCHEMA); // tags is optional
    expect(result.valid).toBe(true);
  });

  it("empty schema always passes", () => {
    const emptySchema: JSONSchemaObject = { type: "object", properties: {} };
    const result = validateOutput({ anything: "goes" }, emptySchema);
    expect(result.valid).toBe(true);
  });

  it("returns descriptive error messages", () => {
    const result = validateOutput({}, OUTPUT_SCHEMA); // missing summary and count
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
    expect(result.errors.some((e: string) => e.includes("summary"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("count"))).toBe(true);
  });

  it("type coercion: string number is coerced for output", () => {
    const result = validateOutput({ summary: "Done", count: "5" }, OUTPUT_SCHEMA);
    // AJV with coerceTypes should accept "5" as a number
    expect(result.valid).toBe(true);
  });
});

// =====================================================
// validateFlowContent
// =====================================================

describe("validateFlowContent", () => {
  it("bare slug without scope is rejected", () => {
    const result = validateFlowContent("Do something", [
      { id: "web-search", description: "Search", content: "..." },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("web-search");
  });

  it("valid prompt and skills pass (scoped name)", () => {
    const result = validateFlowContent("Do something", [
      { id: "@appstrate/web-search", description: "Search", content: "..." },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("empty prompt fails", () => {
    const result = validateFlowContent("", []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("prompt"))).toBe(true);
  });

  it("invalid skill ID fails", () => {
    const result = validateFlowContent("Do something", [
      { id: "Invalid Skill!", description: "Bad", content: "..." },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid Skill!"))).toBe(true);
  });

  it("invalid scoped skill ID fails", () => {
    const result = validateFlowContent("Do something", [
      { id: "@UPPER/case", description: "Bad", content: "..." },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("@UPPER/case"))).toBe(true);
  });

  it("duplicate skill IDs fail", () => {
    const result = validateFlowContent("Do something", [
      { id: "@appstrate/search", description: "A", content: "..." },
      { id: "@appstrate/search", description: "B", content: "..." },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicated"))).toBe(true);
  });
});
