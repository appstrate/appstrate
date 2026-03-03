import { describe, test, expect } from "bun:test";
import type { JSONSchemaObject } from "@appstrate/shared-types";
import { validateManifest } from "@appstrate/validation";
import { validateConfig, validateInput, validateOutput, validateFlowContent } from "../schema.ts";
import { buildRetryPrompt } from "../adapters/prompt-builder.ts";

// --- Fixtures ---

const VALID_MANIFEST = {
  schemaVersion: "1.0.0",
  name: "@test-org/test-flow",
  version: "1.0.0",
  type: "flow",
  displayName: "Test Flow",
  description: "A test flow",
  author: "test",
  tags: ["test"],
  requires: {
    services: [{ id: "gmail", provider: "google-mail" }],
    skills: ["@appstrate/greeting-style"],
    extensions: ["@appstrate/web-search"],
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
  execution: { timeout: 300, outputRetries: 2 },
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
  test("accepts a valid manifest with JSON Schema format", () => {
    const result = validateManifest(VALID_MANIFEST);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest).toBeDefined();
  });

  test("accepts manifest without optional sections (input, output, state)", () => {
    const minimal = {
      schemaVersion: "1.0.0",
      name: "@test-org/minimal",
      version: "1.0.0",
      type: "flow",
      displayName: "Minimal",
      description: "Minimal flow",
      author: "test",
      requires: { services: [] },
    };
    const result = validateManifest(minimal);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("accepts manifest with empty config schema", () => {
    const manifest = {
      ...VALID_MANIFEST,
      config: { schema: { type: "object", properties: {} } },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });

  test("rejects manifest with invalid name (not a slug)", () => {
    const bad = {
      ...VALID_MANIFEST,
      name: "Invalid Name!",
    };
    const result = validateManifest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("name");
  });

  test("rejects manifest missing required fields", () => {
    const bad = {
      schemaVersion: "1.0.0",
      name: "@test-org/test",
      version: "1.0.0",
      type: "flow",
      requires: { services: [] },
    };
    const result = validateManifest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("rejects old-format schema (flat record without type: object)", () => {
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

  test("rejects invalid field type in schema properties", () => {
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

  test("accepts custom placeholder property in schema", () => {
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

  test("accepts required as an array of strings on schema level", () => {
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
  test("valid config passes", () => {
    const data = { max_emails: 20, clickup_list_id: "abc123", language: "fr" };
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("missing required field fails", () => {
    const data = { max_emails: 20, language: "fr" }; // missing clickup_list_id
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.field === "clickup_list_id")).toBe(true);
  });

  test("type coercion: string to number", () => {
    const data = { max_emails: "50", clickup_list_id: "abc123", language: "fr" };
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(true);
  });

  test("enum violation fails", () => {
    const data = { clickup_list_id: "abc", language: "de" }; // "de" not in enum
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "language")).toBe(true);
  });

  test("empty schema always passes", () => {
    const emptySchema: JSONSchemaObject = { type: "object", properties: {} };
    const result = validateConfig({ anything: "goes" }, emptySchema);
    expect(result.valid).toBe(true);
  });

  test("extra fields are accepted (no additionalProperties restriction by default)", () => {
    const data = { clickup_list_id: "abc123", extra_field: "hello" };
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(true);
  });

  test("wrong type without coercion possibility fails", () => {
    const data = { clickup_list_id: "abc", max_emails: "not-a-number" };
    const result = validateConfig(data, CONFIG_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "max_emails")).toBe(true);
  });

  test("schema without required array treats all fields as optional", () => {
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
  test("valid input passes", () => {
    const result = validateInput({ topic: "AI", max_results: 10 }, INPUT_SCHEMA);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("missing required field fails", () => {
    const result = validateInput({ max_results: 10 }, INPUT_SCHEMA); // missing topic
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "topic")).toBe(true);
  });

  test("undefined input with required fields fails", () => {
    const result = validateInput(undefined, INPUT_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "topic")).toBe(true);
  });

  test("undefined input with no required fields passes", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { optional: { type: "string" } },
    };
    const result = validateInput(undefined, schema);
    expect(result.valid).toBe(true);
  });

  test("empty schema always passes", () => {
    const emptySchema: JSONSchemaObject = { type: "object", properties: {} };
    const result = validateInput(undefined, emptySchema);
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({});
  });

  test("type coercion: string to number for input", () => {
    const result = validateInput({ topic: "AI", max_results: "5" }, INPUT_SCHEMA);
    expect(result.valid).toBe(true);
  });

  test("schema with custom keyword (placeholder) does not throw", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        topic: { type: "string", description: "Search topic", placeholder: "ex: AI" },
      },
      required: ["topic"],
    };
    expect(() => validateInput({ topic: "AI" }, schema)).not.toThrow();
    const result = validateInput({ topic: "AI" }, schema);
    expect(result.valid).toBe(true);
  });
});

// =====================================================
// validateConfig (with custom keywords)
// =====================================================

describe("validateConfig with custom keywords", () => {
  test("schema with placeholder does not throw", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        api_key: { type: "string", description: "API key", placeholder: "sk-..." },
      },
      required: ["api_key"],
    };
    expect(() => validateConfig({ api_key: "sk-123" }, schema)).not.toThrow();
    const result = validateConfig({ api_key: "sk-123" }, schema);
    expect(result.valid).toBe(true);
  });
});

// =====================================================
// validateOutput
// =====================================================

describe("validateOutput", () => {
  test("valid output passes", () => {
    const result = validateOutput({ summary: "Done", count: 5, tags: ["a"] }, OUTPUT_SCHEMA);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("missing required field fails", () => {
    const result = validateOutput({ summary: "Done" }, OUTPUT_SCHEMA); // missing count
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e: string) => e.includes("count"))).toBe(true);
  });

  test("extra fields are allowed (additionalProperties: true)", () => {
    const result = validateOutput(
      { summary: "Done", count: 5, state: { last_run: "2024-01-01" }, tokensUsed: 1234 },
      OUTPUT_SCHEMA,
    );
    expect(result.valid).toBe(true);
  });

  test("wrong type on required field fails", () => {
    const result = validateOutput({ summary: "Done", count: "not-a-number" }, OUTPUT_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("count"))).toBe(true);
  });

  test("missing optional field is OK", () => {
    const result = validateOutput({ summary: "Done", count: 5 }, OUTPUT_SCHEMA); // tags is optional
    expect(result.valid).toBe(true);
  });

  test("empty schema always passes", () => {
    const emptySchema: JSONSchemaObject = { type: "object", properties: {} };
    const result = validateOutput({ anything: "goes" }, emptySchema);
    expect(result.valid).toBe(true);
  });

  test("returns descriptive error messages", () => {
    const result = validateOutput({}, OUTPUT_SCHEMA); // missing summary and count
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
    expect(result.errors.some((e: string) => e.includes("summary"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("count"))).toBe(true);
  });

  test("type coercion: string number is coerced for output", () => {
    const result = validateOutput({ summary: "Done", count: "5" }, OUTPUT_SCHEMA);
    // AJV with coerceTypes should accept "5" as a number
    expect(result.valid).toBe(true);
  });
});

// =====================================================
// validateFlowContent
// =====================================================

describe("validateFlowContent", () => {
  test("valid prompt and skills pass (bare slug)", () => {
    const result = validateFlowContent("Do something", [
      { id: "web-search", description: "Search", content: "..." },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("valid prompt and skills pass (scoped name)", () => {
    const result = validateFlowContent("Do something", [
      { id: "@appstrate/web-search", description: "Search", content: "..." },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("empty prompt fails", () => {
    const result = validateFlowContent("", []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("prompt"))).toBe(true);
  });

  test("invalid skill ID fails", () => {
    const result = validateFlowContent("Do something", [
      { id: "Invalid Skill!", description: "Bad", content: "..." },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid Skill!"))).toBe(true);
  });

  test("invalid scoped skill ID fails", () => {
    const result = validateFlowContent("Do something", [
      { id: "@UPPER/case", description: "Bad", content: "..." },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("@UPPER/case"))).toBe(true);
  });

  test("duplicate skill IDs fail", () => {
    const result = validateFlowContent("Do something", [
      { id: "search", description: "A", content: "..." },
      { id: "search", description: "B", content: "..." },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicated"))).toBe(true);
  });
});

// =====================================================
// buildRetryPrompt (uses JSONSchemaObject)
// =====================================================

describe("buildRetryPrompt", () => {
  test("includes required/optional labels from schema.required array", () => {
    const prompt = buildRetryPrompt(
      { summary: "incomplete" },
      ["Field 'count': must be number"],
      OUTPUT_SCHEMA,
    );
    expect(prompt).toContain("summary");
    expect(prompt).toContain("count");
    expect(prompt).toContain("required");
    expect(prompt).toContain("optional"); // tags is optional
  });

  test("correctly labels required fields", () => {
    const prompt = buildRetryPrompt({}, ["missing fields"], OUTPUT_SCHEMA);
    // summary and count are required, tags is optional
    expect(prompt).toContain("**summary** (string, required)");
    expect(prompt).toContain("**count** (number, required)");
    expect(prompt).toContain("**tags** (array, optional)");
  });

  test("includes validation errors in output", () => {
    const errors = ["Field 'count': must be number", "Field 'summary': is required"];
    const prompt = buildRetryPrompt({}, errors, OUTPUT_SCHEMA);
    for (const err of errors) {
      expect(prompt).toContain(err);
    }
  });

  test("includes previous bad result as JSON", () => {
    const badResult = { summary: "partial", extra: true };
    const prompt = buildRetryPrompt(badResult, ["error"], OUTPUT_SCHEMA);
    expect(prompt).toContain('"summary": "partial"');
    expect(prompt).toContain('"extra": true');
  });

  test("handles schema with no required array (all fields optional)", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        name: { type: "string", description: "Name" },
      },
    };
    const prompt = buildRetryPrompt({}, ["error"], schema);
    expect(prompt).toContain("**name** (string, optional)");
  });
});
