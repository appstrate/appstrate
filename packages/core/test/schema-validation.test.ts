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
  });

  it("rejects format violations", () => {
    const result = validateAgainstSchema({ email: "not-an-email" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain("email");
  });
});
