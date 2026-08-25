// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the core `validateAgainstSchema` helper.
 *
 * Both validation call sites (the platform run pipeline and the CLI's
 * local PiRunner path) consume it, so the validate semantics live here as
 * the contract every caller relies on.
 */

import { describe, it, expect } from "bun:test";
import { validateAgainstSchema } from "../src/schema-validation.ts";
import type { JSONSchemaObject } from "../src/form.ts";

describe("validateAgainstSchema", () => {
  const schema: JSONSchemaObject = {
    type: "object",
    properties: {
      email: { type: "string", format: "email" },
      count: { type: "number" },
    },
    required: ["email"],
  };

  it("accepts a config that satisfies the schema", () => {
    const result = validateAgainstSchema({ email: "a@example.com", count: 3 }, schema);
    expect(result.valid).toBe(true);
  });

  it("rejects a missing required field", () => {
    const result = validateAgainstSchema({ count: 3 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.field).toBe("email");
  });

  it("treats empty string and null as missing for required keys", () => {
    expect(validateAgainstSchema({ email: "" }, schema).valid).toBe(false);
    expect(validateAgainstSchema({ email: null }, schema).valid).toBe(false);
  });

  it("short-circuits when the schema declares no properties", () => {
    const empty: JSONSchemaObject = { type: "object", properties: {} };
    expect(validateAgainstSchema({ anything: "goes" }, empty).valid).toBe(true);
    // …and when it declares no `properties` member at all.
    expect(
      validateAgainstSchema({ anything: "goes" }, { type: "object" } as JSONSchemaObject).valid,
    ).toBe(true);
  });

  // The short-circuit above used to test `properties` alone, which is a
  // different question: `properties` says what a NAMED key must look like, and
  // a schema constrains plenty without naming one. Each case below returned
  // `valid: true` BEFORE Ajv ran — and `createAjv` uses `strict: false`, so
  // Ajv would have enforced every one of them.
  describe("an empty `properties` no longer waives the rest of the schema", () => {
    const cases: [string, JSONSchemaObject, Record<string, unknown>][] = [
      [
        "required",
        { type: "object", properties: {}, required: ["must_be_here"] } as JSONSchemaObject,
        {},
      ],
      [
        "additionalProperties: false",
        { type: "object", properties: {}, additionalProperties: false } as JSONSchemaObject,
        { anything: 1 },
      ],
      [
        "allOf",
        { type: "object", allOf: [{ required: ["a"] }] } as unknown as JSONSchemaObject,
        {},
      ],
      [
        "minProperties",
        { type: "object", properties: {}, minProperties: 1 } as unknown as JSONSchemaObject,
        {},
      ],
    ];

    for (const [label, schema, data] of cases) {
      it(`enforces ${label}`, () => {
        expect(validateAgainstSchema(data, schema).valid).toBe(false);
      });
    }

    it("still accepts anything under a schema that constrains nothing (control)", () => {
      const annotated = {
        type: "object",
        title: "Nothing",
        description: "declares no rule",
        properties: {},
      } as unknown as JSONSchemaObject;
      expect(validateAgainstSchema({ whatever: true }, annotated).valid).toBe(true);
    });
  });

  it("rejects format violations", () => {
    const result = validateAgainstSchema({ email: "not-an-email" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain("email");
  });
});
