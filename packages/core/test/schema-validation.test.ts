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

  // Narrowing the short-circuit above (an empty `properties` no longer waives
  // `required` / `allOf` / `additionalProperties`) routed shapes into the
  // compiler that never reached it before. Some of them Ajv refuses to
  // compile, and a refusal used to escape this function as an EXCEPTION —
  // a stack trace out of `appstrate run`, a 500 out of a route whose whole
  // contract is a 400 with per-field errors. The contract is: a result, always.
  describe("a schema Ajv cannot compile yields a result, not an exception", () => {
    const uncompilable: [string, JSONSchemaObject][] = [
      ["allOf: []", { allOf: [] }],
      ["anyOf: []", { anyOf: [] }],
      ["oneOf: []", { oneOf: [] }],
      ["enum: []", { enum: [] }],
      ["allOf: {} (wrong type)", { allOf: {} }],
      ["nullable without a type", { nullable: true }],
      ["$ref to a missing pointer", { $ref: "#/$defs/missing" }],
      ["$ref to an unreachable external URI", { $ref: "https://example.invalid/other.json" }],
      ["allOf: [] alongside real properties", { allOf: [], properties: { a: { type: "string" } } }],
    ] as unknown[] as [string, JSONSchemaObject][];

    for (const [label, badSchema] of uncompilable) {
      it(`reports ${label} as invalid instead of throwing`, () => {
        expect(() => validateAgainstSchema({ a: "x" }, badSchema)).not.toThrow();
        const result = validateAgainstSchema({ a: "x" }, badSchema);
        // NOT `valid: true`: nothing was checked, so nothing can be accepted.
        // Accepting a value no validator ever examined is the one outcome
        // worse than the throw this replaces.
        expect(result.valid).toBe(false);
        expect(result.errors[0]?.message).toBeTruthy();
      });
    }
  });

  // `$schema` names the document's DIALECT and asserts nothing about the
  // value, but the shared instance is an Ajv2020 bound to one dialect: any
  // other URL made `compile` throw "no schema with key or ref …". draft-07 is
  // what most JSON Schema tooling still emits, so this fired on ordinary
  // manifests — and `apps/api` had already worked around it locally, which is
  // precisely the server/CLI drift this module exists to prevent.
  describe("a foreign `$schema` dialect is validated, not refused", () => {
    const shaped = (dialect: string): JSONSchemaObject =>
      ({
        $schema: dialect,
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      }) as unknown as JSONSchemaObject;

    const FOREIGN = [
      "http://json-schema.org/draft-04/schema#",
      "http://json-schema.org/draft-06/schema#",
      "http://json-schema.org/draft-07/schema#",
      "https://json-schema.org/draft/2019-09/schema",
      "https://example.invalid/dialect/v1", // a URL Ajv has never heard of
    ];

    for (const dialect of FOREIGN) {
      it(`reaches a real verdict under ${dialect}`, () => {
        expect(validateAgainstSchema({ name: "ok" }, shaped(dialect)).valid).toBe(true);
        const bad = validateAgainstSchema({}, shaped(dialect));
        expect(bad.valid).toBe(false);
        expect(bad.errors[0]?.field).toBe("name");
      });
    }

    // Anti-weakening control. Dropping `$schema` must make the schema
    // COMPILABLE, never more permissive: everything it forbids is still
    // forbidden, and the native dialect (which never threw) is unchanged.
    it("still rejects everything the schema forbids", () => {
      const draft07 = "http://json-schema.org/draft-07/schema#";
      const closed = {
        $schema: draft07,
        type: "object",
        properties: {},
        additionalProperties: false,
      } as unknown as JSONSchemaObject;
      expect(validateAgainstSchema({ unexpected: 1 }, closed).valid).toBe(false);

      const requiredOnly = { $schema: draft07, required: ["a"] } as unknown as JSONSchemaObject;
      expect(validateAgainstSchema({}, requiredOnly).valid).toBe(false);

      const native = shaped("https://json-schema.org/draft/2020-12/schema");
      expect(validateAgainstSchema({}, native).valid).toBe(false);
      expect(validateAgainstSchema({ name: "ok" }, native).valid).toBe(true);
    });
  });
});
