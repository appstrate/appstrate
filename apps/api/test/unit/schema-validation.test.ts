// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { validateManifest } from "@appstrate/core/validation";
import { MAX_CACHED_VALIDATORS } from "@appstrate/core/schema-validation";
import {
  validateAgainstSchema,
  validateConnectionCredentials,
  validateInput,
  validateOutput,
} from "../../src/services/schema.ts";

// --- Fixtures ---

const VALID_MANIFEST = {
  schema_version: "0.1",
  name: "@test-org/test-agent",
  version: "1.0.0",
  type: "agent",
  display_name: "Test Agent",
  description: "A test agent",
  author: "test",
  dependencies: {
    integrations: { "@appstrate/gmail": "1.0.0" },
    skills: { "@appstrate/greeting-style": "*" },
    mcp_servers: { "@appstrate/web-search": "*" },
  },
  // Declares an output schema below, so the `output` runtime tool must be
  // enabled (enforced by agentManifestSchema's superRefine).
  runtime_tools: ["output"],
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

const VALUES_SCHEMA: JSONSchemaObject = {
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
      schema_version: "0.1",
      name: "@test-org/minimal",
      version: "1.0.0",
      type: "agent",
      display_name: "Minimal",
      description: "Minimal agent",
      author: "test",
      dependencies: { integrations: {} },
    };
    const result = validateManifest(minimal);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts manifest with an empty input schema", () => {
    const manifest = {
      ...VALID_MANIFEST,
      input: { schema: { type: "object", properties: {} } },
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
      schema_version: "0.1",
      name: "@test-org/test",
      version: "1.0.0",
      type: "agent",
      dependencies: { integrations: {} },
    };
    const result = validateManifest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects old-format schema (flat record without type: object)", () => {
    const oldFormat = {
      ...VALID_MANIFEST,
      input: {
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
      input: {
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
    expect(result.errors.some((e: string) => e.includes("JSON Schema") || e.includes("type"))).toBe(
      true,
    );
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
      input: {
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
// validateAgainstSchema
// =====================================================

describe("validateAgainstSchema", () => {
  it("valid values pass", () => {
    const data = { max_emails: 20, clickup_list_id: "abc123", language: "fr" };
    const result = validateAgainstSchema(data, VALUES_SCHEMA);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("missing required field fails", () => {
    const data = { max_emails: 20, language: "fr" }; // missing clickup_list_id
    const result = validateAgainstSchema(data, VALUES_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.field === "clickup_list_id")).toBe(true);
  });

  it("type coercion: string to number", () => {
    const data = { max_emails: "50", clickup_list_id: "abc123", language: "fr" };
    const result = validateAgainstSchema(data, VALUES_SCHEMA);
    expect(result.valid).toBe(true);
  });

  it("enum violation fails", () => {
    const data = { clickup_list_id: "abc", language: "de" }; // "de" not in enum
    const result = validateAgainstSchema(data, VALUES_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "language")).toBe(true);
  });

  it("empty schema always passes", () => {
    const emptySchema: JSONSchemaObject = { type: "object", properties: {} };
    const result = validateAgainstSchema({ anything: "goes" }, emptySchema);
    expect(result.valid).toBe(true);
  });

  it("extra fields are accepted (no additionalProperties restriction by default)", () => {
    const data = { clickup_list_id: "abc123", extra_field: "hello" };
    const result = validateAgainstSchema(data, VALUES_SCHEMA);
    expect(result.valid).toBe(true);
  });

  it("wrong type without coercion possibility fails", () => {
    const data = { clickup_list_id: "abc", max_emails: "not-a-number" };
    const result = validateAgainstSchema(data, VALUES_SCHEMA);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "max_emails")).toBe(true);
  });

  it("empty string on required field fails (aligned with frontend)", () => {
    const data = { clickup_list_id: "", max_emails: 20 };
    const result = validateAgainstSchema(data, VALUES_SCHEMA);
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
    const result = validateAgainstSchema(data, schema);
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
    const result = validateAgainstSchema({}, schema);
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

  /**
   * The shared AJV is an Ajv2020 bound to one dialect, so a manifest declaring
   * draft-07 — what most JSON Schema tooling emits — makes `ajv.compile` throw
   * "no schema with key or ref …/draft-07/schema" rather than return a
   * validator. That is a 500 on a path whose entire contract is a 400 with
   * per-field errors. The effective schema must therefore drop `$schema`: it
   * declares the document's dialect and asserts nothing about the value.
   */
  it("a schema declaring a foreign $schema dialect validates instead of throwing", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    } as unknown as JSONSchemaObject;

    expect(() => validateInput({ topic: "AI" }, schema)).not.toThrow();
    expect(validateInput({ topic: "AI" }, schema).valid).toBe(true);

    // …and it still REJECTS, rather than waving the input through.
    const missing = validateInput({}, schema);
    expect(missing.valid).toBe(false);
    expect(JSON.stringify(missing.errors)).toContain("topic");
  });

  it("a file field does not resurrect the $schema throw", () => {
    // The file-field branch is the one that started spreading the author's
    // schema, so it is the branch that started forwarding `$schema`.
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
        note: { type: "string" },
      },
      required: ["doc"],
    } as unknown as JSONSchemaObject;

    expect(() => validateInput({ note: "hi" }, schema)).not.toThrow();
    expect(validateInput({ note: "hi" }, schema).valid).toBe(true);
  });
});

describe("validateOutput dialect handling", () => {
  it("a schema declaring a foreign $schema dialect validates instead of throwing", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    } as unknown as JSONSchemaObject;

    expect(() => validateOutput({ summary: "done" }, schema)).not.toThrow();
    expect(validateOutput({ summary: "done" }, schema).valid).toBe(true);
    expect(validateOutput({}, schema).valid).toBe(false);
  });
});

// =====================================================
// validateAgainstSchema (with custom keywords)
// =====================================================

describe("validateAgainstSchema with unknown keywords", () => {
  it("schema with unknown keyword does not throw", () => {
    const schema = {
      type: "object",
      properties: {
        api_key: { type: "string", description: "API key", customKeyword: "ignored" },
      },
      required: ["api_key"],
    } as unknown as JSONSchemaObject;
    expect(() => validateAgainstSchema({ api_key: "sk-123" }, schema)).not.toThrow();
    const result = validateAgainstSchema({ api_key: "sk-123" }, schema);
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

/**
 * The server-only validators (`validateInput` / `validateOutput` /
 * `validateConnectionCredentials`) compile through the SAME cache as
 * `@appstrate/core/schema-validation`'s own `validateAgainstSchema` — there is
 * exactly one Ajv instance in the process. These are the two properties that
 * the second, uncapped instance this module used to own did not have.
 */
describe("compiled-validator cache — shared bound", () => {
  it("compiles a schema carrying a $id twice without colliding in the registry", () => {
    // Two structurally identical but DISTINCT objects under one `$id`. An Ajv
    // instance that keeps compiled schemas registered throws
    // "schema with key or id ... already exists" on the second one.
    const withId = (): JSONSchemaObject =>
      ({
        $id: "https://example.test/creds.json",
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
      }) as unknown as JSONSchemaObject;

    expect(validateConnectionCredentials(withId(), { token: "a" }).valid).toBe(true);
    expect(() => validateConnectionCredentials(withId(), { token: "b" })).not.toThrow();
    // …and across the two callers, which now share the instance.
    expect(() => validateAgainstSchema({ token: "c" }, withId())).not.toThrow();
  });

  it("keeps validating correctly past the eviction bound, on both callers", () => {
    // Well past MAX_CACHED_VALIDATORS distinct schemas: every one evicts an
    // older entry rather than growing the map, and an evicted schema simply
    // recompiles. A caller that fell off the end must still get the right
    // verdict.
    const distinct = (i: number): JSONSchemaObject => ({
      type: "object",
      properties: { [`field_${i}`]: { type: "string" } },
      required: [`field_${i}`],
    });

    for (let i = 0; i < MAX_CACHED_VALIDATORS + 50; i++) {
      expect(validateInput({ [`field_${i}`]: "x" }, distinct(i)).valid).toBe(true);
      expect(validateAgainstSchema({ [`field_${i}`]: "x" }, distinct(i)).valid).toBe(true);
    }

    // The very first schema was evicted long ago; it recompiles and still
    // reaches the same verdict.
    expect(validateInput({}, distinct(0)).valid).toBe(false);
    expect(validateAgainstSchema({}, distinct(0)).valid).toBe(false);
  });
});

/**
 * `runValidate` used to answer two questions with one test — "does this schema
 * name a property?" standing in for "does this schema constrain anything?" —
 * and then, past that gate, rebuild the input schema as a bare
 * `{type, properties, required}`. Both discard rules the author wrote down.
 *
 * The verdicts below are the AUTHOR'S schema applied as written; every one of
 * them was `valid: true` before.
 */
describe("the declared schema is applied as written", () => {
  it("enforces a constraint that names no property (input)", () => {
    const closed = {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as unknown as JSONSchemaObject;
    expect(validateInput({ surprise: 1 }, closed).valid).toBe(false);

    const requiresUnnamed = {
      type: "object",
      properties: {},
      required: ["must_be_here"],
    } as unknown as JSONSchemaObject;
    expect(validateInput({}, requiresUnnamed).valid).toBe(false);
  });

  it("enforces a constraint that names no property (output)", () => {
    // `additionalProperties` is deliberately relaxed on the output path, so the
    // case that proves the short-circuit is `required`.
    const requiresUnnamed = {
      type: "object",
      properties: {},
      required: ["must_be_here"],
    } as unknown as JSONSchemaObject;
    expect(validateOutput({}, requiresUnnamed).valid).toBe(false);
  });

  it("enforces a constraint that names no property (connection credentials)", () => {
    const requiresUnnamed = {
      type: "object",
      properties: {},
      required: ["api_key"],
    } as unknown as JSONSchemaObject;
    expect(validateConnectionCredentials(requiresUnnamed, {}).valid).toBe(false);
    // A genuinely loose `custom` auth is still waved through (control).
    expect(
      validateConnectionCredentials({ type: "object", properties: {} }, { whatever: 1 }).valid,
    ).toBe(true);
  });

  it("keeps the keywords the three-key rebuild dropped from an input schema", () => {
    const declared = {
      type: "object",
      properties: { topic: { type: "string" }, locale: { type: "string" } },
      required: ["topic"],
      additionalProperties: false,
      $defs: { unused: { type: "string" } },
      dependentRequired: { topic: ["locale"] },
    } as unknown as JSONSchemaObject;

    // `additionalProperties: false` — an undeclared key is refused.
    expect(validateInput({ topic: "AI", locale: "fr", extra: 1 }, declared).valid).toBe(false);
    // `dependentRequired` — `topic` present pulls `locale` in with it.
    expect(validateInput({ topic: "AI" }, declared).valid).toBe(false);
    // …and the body that satisfies all of it still passes (control).
    expect(validateInput({ topic: "AI", locale: "fr" }, declared).valid).toBe(true);
  });

  it("still ignores a file field's own assertions, and still does not require it", () => {
    // The file-field exclusion is why the rebuild existed. It must survive: the
    // parser has already rewritten the value to an `appfile://…` URI that the
    // declared `format: uri` + `contentMediaType` would reject, and whether a
    // file was supplied is the upload pipeline's question, not AJV's.
    const withFile = {
      type: "object",
      properties: {
        topic: { type: "string" },
        doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
      },
      required: ["topic", "doc"],
      additionalProperties: false,
    } as unknown as JSONSchemaObject;

    // Required file field absent → still valid.
    expect(validateInput({ topic: "AI" }, withFile).valid).toBe(true);
    // Present as the resolved URI → accepted, and NOT read as an unexpected
    // extra even though the object is closed (the reason the exclusion relaxes
    // the property instead of deleting the key).
    expect(validateInput({ topic: "AI", doc: "appfile://file_abc" }, withFile).valid).toBe(true);
    // The non-file half of the schema is still enforced.
    expect(validateInput({ doc: "appfile://file_abc" }, withFile).valid).toBe(false);
  });
});
