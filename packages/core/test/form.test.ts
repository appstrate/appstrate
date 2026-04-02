// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  isFileField,
  schemaToFields,
  initFormValues,
  buildPayload,
  validateFormValues,
  type JSONSchemaObject,
  type JSONSchema7,
  type SchemaWrapper,
} from "../src/form.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrap(
  schema: JSONSchemaObject,
  opts?: Partial<Omit<SchemaWrapper, "schema">>,
): SchemaWrapper {
  return { schema, ...opts };
}

function obj(properties: Record<string, JSONSchema7>, required?: string[]): JSONSchemaObject {
  return { type: "object", properties, required };
}

// ---------------------------------------------------------------------------
// isFileField
// ---------------------------------------------------------------------------

describe("isFileField", () => {
  test("plain string → false", () => {
    expect(isFileField({ type: "string" })).toBe(false);
  });

  test('format "uri" without contentMediaType → false', () => {
    expect(isFileField({ type: "string", format: "uri" })).toBe(false);
  });

  test('format "uri" + contentMediaType → true (single file)', () => {
    expect(
      isFileField({ type: "string", format: "uri", contentMediaType: "application/pdf" }),
    ).toBe(true);
  });

  test("array of file items → true", () => {
    expect(
      isFileField({
        type: "array",
        items: { type: "string", format: "uri", contentMediaType: "text/csv" },
      }),
    ).toBe(true);
  });

  test("array of non-file items → false", () => {
    expect(isFileField({ type: "array", items: { type: "string" } })).toBe(false);
  });

  test("number → false", () => {
    expect(isFileField({ type: "number" })).toBe(false);
  });

  test("empty property → false", () => {
    expect(isFileField({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// schemaToFields
// ---------------------------------------------------------------------------

describe("schemaToFields", () => {
  test("empty properties → []", () => {
    expect(schemaToFields(wrap(obj({})))).toEqual([]);
  });

  test("null-ish schema → []", () => {
    expect(schemaToFields(wrap(null as unknown as JSONSchemaObject))).toEqual([]);
  });

  test("string field", () => {
    const fields = schemaToFields(
      wrap(obj({ name: { type: "string", description: "Your name" } })),
    );
    expect(fields).toHaveLength(1);
    expect(fields[0]!.type).toBe("text");
    expect(fields[0]!.label).toBe("name");
    expect(fields[0]!.description).toBe("Your name");
  });

  test("number field", () => {
    const fields = schemaToFields(wrap(obj({ count: { type: "number" } })));
    expect(fields[0]!.type).toBe("number");
  });

  test("integer treated as number", () => {
    const fields = schemaToFields(wrap(obj({ count: { type: "integer" } })));
    expect(fields[0]!.type).toBe("number");
  });

  test("boolean field", () => {
    const fields = schemaToFields(wrap(obj({ verbose: { type: "boolean" } })));
    expect(fields[0]!.type).toBe("boolean");
  });

  test("enum field", () => {
    const fields = schemaToFields(
      wrap(obj({ format: { type: "string", enum: ["json", "csv", "xml"] } })),
    );
    expect(fields[0]!.type).toBe("enum");
    expect(fields[0]!.enumValues).toEqual(["json", "csv", "xml"]);
  });

  test("enum without type → still enum", () => {
    const fields = schemaToFields(wrap(obj({ mode: { enum: ["fast", "slow"] } })));
    expect(fields[0]!.type).toBe("enum");
    expect(fields[0]!.enumValues).toEqual(["fast", "slow"]);
  });

  test("enum with numeric values → stringified", () => {
    const fields = schemaToFields(wrap(obj({ level: { type: "number", enum: [1, 2, 3] } })));
    expect(fields[0]!.type).toBe("enum");
    expect(fields[0]!.enumValues).toEqual(["1", "2", "3"]);
  });

  test("textarea detected via maxLength > 500", () => {
    const fields = schemaToFields(wrap(obj({ body: { type: "string", maxLength: 5000 } })));
    expect(fields[0]!.type).toBe("textarea");
  });

  test("maxLength ≤ 500 → text (not textarea)", () => {
    const fields = schemaToFields(wrap(obj({ title: { type: "string", maxLength: 200 } })));
    expect(fields[0]!.type).toBe("text");
  });

  test("single file field", () => {
    const fields = schemaToFields(
      wrap(obj({ doc: { type: "string", format: "uri", contentMediaType: "application/pdf" } })),
    );
    expect(fields[0]!.type).toBe("file");
  });

  test("multiple file field", () => {
    const fields = schemaToFields(
      wrap(
        obj({
          docs: {
            type: "array",
            items: { type: "string", format: "uri", contentMediaType: "text/csv" },
            maxItems: 5,
          },
        }),
      ),
    );
    expect(fields[0]!.type).toBe("file-multiple");
    expect(fields[0]!.fileConstraints?.maxFiles).toBe(5);
  });

  test("required propagated", () => {
    const fields = schemaToFields(
      wrap(obj({ a: { type: "string" }, b: { type: "string" } }, ["a"])),
    );
    expect(fields[0]!.required).toBe(true);
    expect(fields[1]!.required).toBe(false);
  });

  test("default extracted", () => {
    const fields = schemaToFields(wrap(obj({ lang: { type: "string", default: "fr" } })));
    expect(fields[0]!.defaultValue).toBe("fr");
  });

  test("uiHints placeholder", () => {
    const fields = schemaToFields(
      wrap(obj({ email: { type: "string" } }), {
        uiHints: { email: { placeholder: "you@example.com" } },
      }),
    );
    expect(fields[0]!.placeholder).toBe("you@example.com");
  });

  test("placeholder falls back to description", () => {
    const fields = schemaToFields(
      wrap(obj({ email: { type: "string", description: "Your email" } })),
    );
    expect(fields[0]!.placeholder).toBe("Your email");
  });

  test("uiHints placeholder takes priority over description", () => {
    const fields = schemaToFields(
      wrap(obj({ email: { type: "string", description: "desc" } }), {
        uiHints: { email: { placeholder: "hint" } },
      }),
    );
    expect(fields[0]!.placeholder).toBe("hint");
  });

  test("propertyOrder respected", () => {
    const fields = schemaToFields(
      wrap(obj({ a: { type: "string" }, b: { type: "string" }, c: { type: "string" } }), {
        propertyOrder: ["c", "a", "b"],
      }),
    );
    expect(fields.map((f) => f.key)).toEqual(["c", "a", "b"]);
  });

  test("fileConstraints mapped", () => {
    const fields = schemaToFields(
      wrap(obj({ doc: { type: "string", format: "uri", contentMediaType: "application/pdf" } }), {
        fileConstraints: { doc: { accept: ".pdf", maxSize: 10_000_000 } },
      }),
    );
    expect(fields[0]!.fileConstraints).toEqual({
      accept: ".pdf",
      maxSize: 10_000_000,
      maxFiles: undefined,
    });
  });

  test("validation constraints extracted", () => {
    const fields = schemaToFields(
      wrap(
        obj({
          score: { type: "number", minimum: 0, maximum: 100 },
          name: { type: "string", minLength: 1, maxLength: 50, pattern: "^[a-z]+$" },
        }),
      ),
    );
    expect(fields[0]!.validation).toEqual({ minimum: 0, maximum: 100 });
    expect(fields[1]!.validation).toEqual({ minLength: 1, maxLength: 50, pattern: "^[a-z]+$" });
  });

  test("no validation → validation is undefined", () => {
    const fields = schemaToFields(wrap(obj({ x: { type: "string" } })));
    expect(fields[0]!.validation).toBeUndefined();
  });

  test("missing type → defaults to text", () => {
    const fields = schemaToFields(wrap(obj({ x: {} })));
    expect(fields[0]!.type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// initFormValues
// ---------------------------------------------------------------------------

describe("initFormValues", () => {
  test("empty schema → {}", () => {
    expect(initFormValues(obj({}))).toEqual({});
  });

  test("null-ish schema → {}", () => {
    expect(initFormValues(null as unknown as JSONSchemaObject)).toEqual({});
  });

  test("defaults applied", () => {
    const result = initFormValues(obj({ lang: { type: "string", default: "fr" } }));
    expect(result).toEqual({ lang: "fr" });
  });

  test("existing values take priority over defaults", () => {
    const result = initFormValues(obj({ lang: { type: "string", default: "fr" } }), { lang: "en" });
    expect(result).toEqual({ lang: "en" });
  });

  test("field without default or existing → empty string", () => {
    const result = initFormValues(obj({ name: { type: "string" } }));
    expect(result).toEqual({ name: "" });
  });

  test("file fields excluded", () => {
    const result = initFormValues(
      obj({
        name: { type: "string" },
        doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
      }),
    );
    expect(result).toEqual({ name: "" });
    expect("doc" in result).toBe(false);
  });

  test("boolean default false preserved", () => {
    const result = initFormValues(obj({ verbose: { type: "boolean", default: false } }));
    expect(result.verbose).toBe(false);
  });

  test("number default 0 preserved", () => {
    const result = initFormValues(obj({ count: { type: "number", default: 0 } }));
    expect(result.count).toBe(0);
  });

  test("existing null → falls back to default", () => {
    const result = initFormValues(obj({ x: { type: "string", default: "d" } }), { x: null });
    expect(result.x).toBe("d");
  });

  test("existing undefined → falls back to default", () => {
    const result = initFormValues(obj({ x: { type: "string", default: "d" } }), {
      x: undefined,
    });
    expect(result.x).toBe("d");
  });

  test("partial existing → merge with defaults", () => {
    const schema = obj({
      a: { type: "string", default: "da" },
      b: { type: "string", default: "db" },
    });
    const result = initFormValues(schema, { a: "custom" });
    expect(result).toEqual({ a: "custom", b: "db" });
  });

  test("existing false (boolean) preserved", () => {
    const result = initFormValues(obj({ flag: { type: "boolean", default: true } }), {
      flag: false,
    });
    expect(result.flag).toBe(false);
  });

  test("existing 0 (number) preserved", () => {
    const result = initFormValues(obj({ n: { type: "number", default: 10 } }), { n: 0 });
    expect(result.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildPayload
// ---------------------------------------------------------------------------

describe("buildPayload", () => {
  test("empty schema → {}", () => {
    expect(buildPayload(obj({}), {})).toEqual({});
  });

  test("null-ish schema → {}", () => {
    expect(buildPayload(null as unknown as JSONSchemaObject, {})).toEqual({});
  });

  test("string passthrough", () => {
    const result = buildPayload(obj({ name: { type: "string" } }), { name: "hello" });
    expect(result).toEqual({ name: "hello" });
  });

  test('number coercion from string "42" → 42', () => {
    const result = buildPayload(obj({ count: { type: "number" } }), { count: "42" });
    expect(result.count).toBe(42);
  });

  test('number coercion from string "3.14" → 3.14', () => {
    const result = buildPayload(obj({ val: { type: "number" } }), { val: "3.14" });
    expect(result.val).toBe(3.14);
  });

  test("integer coercion", () => {
    const result = buildPayload(obj({ n: { type: "integer" } }), { n: "7" });
    expect(result.n).toBe(7);
  });

  test("empty string → null", () => {
    const result = buildPayload(obj({ name: { type: "string" } }), { name: "" });
    expect(result.name).toBeNull();
  });

  test("undefined value → null", () => {
    const result = buildPayload(obj({ name: { type: "string" } }), {});
    expect(result.name).toBeNull();
  });

  test("number 0 preserved (NOT null)", () => {
    const result = buildPayload(obj({ count: { type: "number" } }), { count: 0 });
    expect(result.count).toBe(0);
  });

  test("boolean false preserved (NOT null)", () => {
    const result = buildPayload(obj({ flag: { type: "boolean" } }), { flag: false });
    expect(result.flag).toBe(false);
  });

  test('boolean string "true" → true', () => {
    const result = buildPayload(obj({ flag: { type: "boolean" } }), { flag: "true" });
    expect(result.flag).toBe(true);
  });

  test('boolean string "false" → false', () => {
    const result = buildPayload(obj({ flag: { type: "boolean" } }), { flag: "false" });
    expect(result.flag).toBe(false);
  });

  test("boolean true passthrough", () => {
    const result = buildPayload(obj({ flag: { type: "boolean" } }), { flag: true });
    expect(result.flag).toBe(true);
  });

  test("file fields excluded", () => {
    const result = buildPayload(
      obj({
        name: { type: "string" },
        doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
      }),
      { name: "test", doc: "should-be-ignored" },
    );
    expect(result).toEqual({ name: "test" });
    expect("doc" in result).toBe(false);
  });

  test("invalid number string → NaN", () => {
    const result = buildPayload(obj({ n: { type: "number" } }), { n: "abc" });
    expect(result.n).toBeNaN();
  });

  test("number value passthrough (no double coercion)", () => {
    const result = buildPayload(obj({ n: { type: "number" } }), { n: 42 });
    expect(result.n).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// validateFormValues
// ---------------------------------------------------------------------------

describe("validateFormValues", () => {
  test("empty schema → no errors", () => {
    expect(validateFormValues(obj({}), {})).toEqual([]);
  });

  test("null-ish schema → no errors", () => {
    expect(validateFormValues(null as unknown as JSONSchemaObject, {})).toEqual([]);
  });

  test("all valid → no errors", () => {
    const schema = obj({ name: { type: "string" }, count: { type: "number" } }, ["name"]);
    expect(validateFormValues(schema, { name: "hello", count: 5 })).toEqual([]);
  });

  // --- Required field checks ---

  test("required field missing → error", () => {
    const errors = validateFormValues(obj({ name: { type: "string" } }, ["name"]), {});
    expect(errors).toHaveLength(1);
    expect(errors[0]!.key).toBe("name");
    expect(errors[0]!.message).toBe("required");
  });

  test("required field empty string → error", () => {
    const errors = validateFormValues(obj({ name: { type: "string" } }, ["name"]), { name: "" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("required");
  });

  test("required field null → error", () => {
    const errors = validateFormValues(obj({ name: { type: "string" } }, ["name"]), { name: null });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("required");
  });

  test("required field 0 → valid (NOT an error)", () => {
    const errors = validateFormValues(obj({ count: { type: "number" } }, ["count"]), { count: 0 });
    expect(errors).toEqual([]);
  });

  test("required field false → valid (NOT an error)", () => {
    const errors = validateFormValues(obj({ flag: { type: "boolean" } }, ["flag"]), {
      flag: false,
    });
    expect(errors).toEqual([]);
  });

  // --- Type checks ---

  test("number type mismatch → error", () => {
    const errors = validateFormValues(obj({ n: { type: "number" } }, ["n"]), { n: "abc" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("type");
  });

  test("number from string accepted", () => {
    const errors = validateFormValues(obj({ n: { type: "number" } }), { n: "42" });
    expect(errors).toEqual([]);
  });

  test("integer type mismatch → error", () => {
    const errors = validateFormValues(obj({ n: { type: "integer" } }, ["n"]), { n: "xyz" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("type");
  });

  test("boolean type mismatch → error", () => {
    const errors = validateFormValues(obj({ flag: { type: "boolean" } }, ["flag"]), {
      flag: "maybe",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("type");
  });

  test('boolean string "true" accepted', () => {
    const errors = validateFormValues(obj({ flag: { type: "boolean" } }), { flag: "true" });
    expect(errors).toEqual([]);
  });

  test('boolean string "false" accepted', () => {
    const errors = validateFormValues(obj({ flag: { type: "boolean" } }), { flag: "false" });
    expect(errors).toEqual([]);
  });

  // --- Enum checks ---

  test("enum valid value → no error", () => {
    const errors = validateFormValues(obj({ fmt: { type: "string", enum: ["json", "csv"] } }), {
      fmt: "json",
    });
    expect(errors).toEqual([]);
  });

  test("enum invalid value → error", () => {
    const errors = validateFormValues(obj({ fmt: { type: "string", enum: ["json", "csv"] } }), {
      fmt: "xml",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("enum");
    expect(errors[0]!.params?.allowed).toEqual(["json", "csv"]);
  });

  test("enum with numeric values — number matches", () => {
    const errors = validateFormValues(obj({ level: { type: "number", enum: [1, 2, 3] } }), {
      level: 2,
    });
    expect(errors).toEqual([]);
  });

  // --- Number min/max ---

  test("number below minimum → error", () => {
    const errors = validateFormValues(obj({ score: { type: "number", minimum: 0 } }), {
      score: -1,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("minimum");
    expect(errors[0]!.params).toEqual({ minimum: 0, actual: -1 });
  });

  test("number above maximum → error", () => {
    const errors = validateFormValues(obj({ score: { type: "number", maximum: 100 } }), {
      score: 101,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("maximum");
  });

  test("number at boundary → valid", () => {
    const schema = obj({ score: { type: "number", minimum: 0, maximum: 100 } });
    expect(validateFormValues(schema, { score: 0 })).toEqual([]);
    expect(validateFormValues(schema, { score: 100 })).toEqual([]);
  });

  // --- String length ---

  test("string below minLength → error", () => {
    const errors = validateFormValues(obj({ name: { type: "string", minLength: 3 } }), {
      name: "ab",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("minLength");
  });

  test("string above maxLength → error", () => {
    const errors = validateFormValues(obj({ name: { type: "string", maxLength: 5 } }), {
      name: "toolong",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("maxLength");
  });

  test("string at length boundary → valid", () => {
    const schema = obj({ name: { type: "string", minLength: 2, maxLength: 5 } });
    expect(validateFormValues(schema, { name: "ab" })).toEqual([]);
    expect(validateFormValues(schema, { name: "abcde" })).toEqual([]);
  });

  // --- Pattern ---

  test("pattern match → valid", () => {
    const errors = validateFormValues(obj({ code: { type: "string", pattern: "^[A-Z]{3}$" } }), {
      code: "ABC",
    });
    expect(errors).toEqual([]);
  });

  test("pattern mismatch → error", () => {
    const errors = validateFormValues(obj({ code: { type: "string", pattern: "^[A-Z]{3}$" } }), {
      code: "abc",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("pattern");
  });

  test("invalid regex pattern → skipped (no crash)", () => {
    const errors = validateFormValues(obj({ x: { type: "string", pattern: "[invalid" } }), {
      x: "anything",
    });
    expect(errors).toEqual([]);
  });

  // --- Optional fields ---

  test("optional empty field → no error", () => {
    const errors = validateFormValues(obj({ name: { type: "string" } }), { name: "" });
    expect(errors).toEqual([]);
  });

  test("optional field with invalid value → error", () => {
    const errors = validateFormValues(obj({ n: { type: "number" } }), { n: "abc" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("type");
  });

  // --- Multiple errors ---

  test("multiple fields with errors → all reported", () => {
    const schema = obj(
      {
        name: { type: "string" },
        count: { type: "number" },
        fmt: { type: "string", enum: ["a", "b"] },
      },
      ["name", "count"],
    );
    const errors = validateFormValues(schema, { name: "", count: null, fmt: "c" });
    expect(errors).toHaveLength(3);
    const keys = errors.map((e) => e.key);
    expect(keys).toContain("name");
    expect(keys).toContain("count");
    expect(keys).toContain("fmt");
  });

  // --- File fields skipped ---

  test("file fields not validated", () => {
    const schema = obj(
      { doc: { type: "string", format: "uri", contentMediaType: "application/pdf" } },
      ["doc"],
    );
    const errors = validateFormValues(schema, {});
    expect(errors).toEqual([]);
  });

  // --- No type specified ---

  test("field without type treated as string", () => {
    const errors = validateFormValues(obj({ x: { minLength: 3 } }), { x: "ab" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("minLength");
  });
});

// ---------------------------------------------------------------------------
// Complex / end-to-end schemas
// ---------------------------------------------------------------------------

describe("complex schemas", () => {
  const emailSenderSchema: SchemaWrapper = {
    schema: obj(
      {
        to: { type: "string", description: "Recipient email" },
        subject: { type: "string", maxLength: 200 },
        body: { type: "string", maxLength: 5000, description: "Email body" },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        attachment: { type: "string", format: "uri", contentMediaType: "application/pdf" },
      },
      ["to", "subject"],
    ),
    uiHints: { to: { placeholder: "user@example.com" } },
    fileConstraints: { attachment: { accept: ".pdf,.docx", maxSize: 10_000_000 } },
    propertyOrder: ["to", "subject", "priority", "body", "attachment"],
  };

  test("email sender — schemaToFields", () => {
    const fields = schemaToFields(emailSenderSchema);
    expect(fields).toHaveLength(5);
    expect(fields.map((f) => f.key)).toEqual(["to", "subject", "priority", "body", "attachment"]);
    expect(fields[0]!.type).toBe("text");
    expect(fields[0]!.required).toBe(true);
    expect(fields[0]!.placeholder).toBe("user@example.com");
    expect(fields[1]!.type).toBe("text");
    expect(fields[1]!.required).toBe(true);
    expect(fields[2]!.type).toBe("enum");
    expect(fields[2]!.enumValues).toEqual(["low", "normal", "high"]);
    expect(fields[3]!.type).toBe("textarea");
    expect(fields[4]!.type).toBe("file");
    expect(fields[4]!.fileConstraints?.accept).toBe(".pdf,.docx");
  });

  test("email sender — initFormValues + buildPayload roundtrip", () => {
    const values = initFormValues(emailSenderSchema.schema);
    expect(values.to).toBe("");
    expect(values.subject).toBe("");
    expect("attachment" in values).toBe(false);

    values.to = "test@example.com";
    values.subject = "Hello";
    values.priority = "high";
    values.body = "Body text";

    const payload = buildPayload(emailSenderSchema.schema, values);
    expect(payload.to).toBe("test@example.com");
    expect(payload.subject).toBe("Hello");
    expect(payload.priority).toBe("high");
    expect(payload.body).toBe("Body text");
    expect("attachment" in payload).toBe(false);
  });

  test("email sender — validateFormValues", () => {
    const errors = validateFormValues(emailSenderSchema.schema, { to: "", subject: "Hello" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.key).toBe("to");
    expect(errors[0]!.message).toBe("required");
  });

  const dataProcessorSchema: SchemaWrapper = {
    schema: obj(
      {
        url: { type: "string", pattern: "^https?://" },
        count: { type: "number", minimum: 1, maximum: 100, default: 10 },
        format: { type: "string", enum: ["json", "csv", "xml"] },
        verbose: { type: "boolean", default: false },
      },
      ["url"],
    ),
  };

  test("data processor — initFormValues with defaults", () => {
    const values = initFormValues(dataProcessorSchema.schema);
    expect(values.url).toBe("");
    expect(values.count).toBe(10);
    expect(values.format).toBe("");
    expect(values.verbose).toBe(false);
  });

  test("data processor — validate pattern + range", () => {
    const errors = validateFormValues(dataProcessorSchema.schema, {
      url: "not-a-url",
      count: 200,
      format: "json",
      verbose: true,
    });
    expect(errors).toHaveLength(2);
    const msgs = errors.map((e) => `${e.key}:${e.message}`);
    expect(msgs).toContain("url:pattern");
    expect(msgs).toContain("count:maximum");
  });

  test("data processor — full roundtrip", () => {
    const values = initFormValues(dataProcessorSchema.schema, { url: "https://example.com" });
    expect(values.url).toBe("https://example.com");
    expect(values.count).toBe(10);

    const errors = validateFormValues(dataProcessorSchema.schema, values);
    expect(errors).toEqual([]);

    const payload = buildPayload(dataProcessorSchema.schema, values);
    expect(payload.url).toBe("https://example.com");
    expect(payload.count).toBe(10);
    expect(payload.verbose).toBe(false);
  });

  test("schema with all types simultaneously", () => {
    const allTypesSchema = obj(
      {
        name: { type: "string", minLength: 1 },
        age: { type: "integer", minimum: 0, maximum: 150 },
        active: { type: "boolean" },
        role: { type: "string", enum: ["admin", "user"] },
        bio: { type: "string", maxLength: 2000 },
        avatar: { type: "string", format: "uri", contentMediaType: "image/png" },
        docs: {
          type: "array",
          items: { type: "string", format: "uri", contentMediaType: "application/pdf" },
          maxItems: 3,
        },
      },
      ["name", "role"],
    );

    const fields = schemaToFields(wrap(allTypesSchema));
    expect(fields).toHaveLength(7);
    const types = fields.map((f) => f.type);
    expect(types).toEqual([
      "text",
      "number",
      "boolean",
      "enum",
      "textarea",
      "file",
      "file-multiple",
    ]);

    const values = initFormValues(allTypesSchema);
    expect(Object.keys(values)).toEqual(["name", "age", "active", "role", "bio"]);
    // Note: avatar/docs are file fields, excluded from initFormValues
    expect("avatar" in values).toBe(false);
    expect("docs" in values).toBe(false);

    const errors = validateFormValues(allTypesSchema, { name: "Jo", role: "admin", age: 25 });
    expect(errors).toEqual([]);

    const missingErrors = validateFormValues(allTypesSchema, { name: "", role: "" });
    expect(missingErrors).toHaveLength(2);
  });

  test("number from string in validation context", () => {
    const schema = obj({ n: { type: "number", minimum: 5, maximum: 10 } });
    // String "7" should be accepted and range-checked
    expect(validateFormValues(schema, { n: "7" })).toEqual([]);
    // String "3" should fail minimum
    const errors = validateFormValues(schema, { n: "3" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("minimum");
  });
});

// ---------------------------------------------------------------------------
// JSON (object/array) field support
// ---------------------------------------------------------------------------

describe("json field type", () => {
  test("schemaToFields: object → json", () => {
    const fields = schemaToFields(wrap(obj({ meta: { type: "object" } })));
    expect(fields[0]!.type).toBe("json");
  });

  test("schemaToFields: array (non-file) → json", () => {
    const fields = schemaToFields(
      wrap(obj({ tags: { type: "array", items: { type: "string" } } })),
    );
    expect(fields[0]!.type).toBe("json");
  });

  test("schemaToFields: array file → file-multiple (not json)", () => {
    const fields = schemaToFields(
      wrap(
        obj({
          docs: {
            type: "array",
            items: { type: "string", format: "uri", contentMediaType: "application/pdf" },
          },
        }),
      ),
    );
    expect(fields[0]!.type).toBe("file-multiple");
  });

  test("initFormValues: object default → JSON string", () => {
    const values = initFormValues(obj({ meta: { type: "object", default: { foo: "bar" } } }));
    expect(values.meta).toBe('{\n  "foo": "bar"\n}');
  });

  test("initFormValues: array default → JSON string", () => {
    const values = initFormValues(obj({ tags: { type: "array", default: ["a", "b"] } }));
    expect(values.tags).toBe('[\n  "a",\n  "b"\n]');
  });

  test("initFormValues: object no default → {}", () => {
    const values = initFormValues(obj({ meta: { type: "object" } }));
    expect(values.meta).toBe("{}");
  });

  test("initFormValues: array no default → []", () => {
    const values = initFormValues(obj({ tags: { type: "array" } }));
    expect(values.tags).toBe("[]");
  });

  test("initFormValues: existing object → serialized", () => {
    const values = initFormValues(obj({ meta: { type: "object" } }), { meta: { x: 1 } });
    expect(values.meta).toBe('{\n  "x": 1\n}');
  });

  test("buildPayload: JSON string → parsed object", () => {
    const result = buildPayload(obj({ meta: { type: "object" } }), { meta: '{"x":1}' });
    expect(result.meta).toEqual({ x: 1 });
  });

  test("buildPayload: JSON string → parsed array", () => {
    const result = buildPayload(obj({ tags: { type: "array" } }), { tags: '["a","b"]' });
    expect(result.tags).toEqual(["a", "b"]);
  });

  test("buildPayload: invalid JSON string → kept as string", () => {
    const result = buildPayload(obj({ meta: { type: "object" } }), { meta: "not json" });
    expect(result.meta).toBe("not json");
  });

  test("buildPayload: already an object → passthrough", () => {
    const result = buildPayload(obj({ meta: { type: "object" } }), { meta: { x: 1 } });
    expect(result.meta).toEqual({ x: 1 });
  });

  test("validateFormValues: valid JSON object string → no error", () => {
    const errors = validateFormValues(obj({ meta: { type: "object" } }), { meta: '{"x":1}' });
    expect(errors).toEqual([]);
  });

  test("validateFormValues: valid JSON array string → no error", () => {
    const errors = validateFormValues(obj({ tags: { type: "array" } }), { tags: '["a"]' });
    expect(errors).toEqual([]);
  });

  test("validateFormValues: invalid JSON → type error", () => {
    const errors = validateFormValues(obj({ meta: { type: "object" } }), { meta: "not json" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("type");
  });

  test("validateFormValues: array string for object type → type error", () => {
    const errors = validateFormValues(obj({ meta: { type: "object" } }), { meta: "[1,2]" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("type");
  });

  test("validateFormValues: object string for array type → type error", () => {
    const errors = validateFormValues(obj({ tags: { type: "array" } }), { tags: '{"x":1}' });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("type");
  });

  test("validateFormValues: required object empty string → required error", () => {
    const errors = validateFormValues(obj({ meta: { type: "object" } }, ["meta"]), { meta: "" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("required");
  });
});
