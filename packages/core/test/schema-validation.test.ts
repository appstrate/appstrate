// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the core `validateConfig` helper.
 *
 * Both validation call sites (the platform run pipeline and the CLI's
 * local PiRunner path) consume it, so the validate semantics live here as
 * the contract every caller relies on.
 */

import { describe, it, expect } from "bun:test";
import { validateConfig } from "../src/schema-validation.ts";
import type { JSONSchemaObject } from "../src/form.ts";

describe("validateConfig", () => {
  const schema: JSONSchemaObject = {
    type: "object",
    properties: {
      email: { type: "string", format: "email" },
      count: { type: "number" },
    },
    required: ["email"],
  };

  it("accepts a config that satisfies the schema", () => {
    const result = validateConfig({ email: "a@example.com", count: 3 }, schema);
    expect(result.valid).toBe(true);
  });

  it("rejects a missing required field", () => {
    const result = validateConfig({ count: 3 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.field).toBe("email");
  });

  it("treats empty string and null as missing for required keys", () => {
    expect(validateConfig({ email: "" }, schema).valid).toBe(false);
    expect(validateConfig({ email: null }, schema).valid).toBe(false);
  });

  it("short-circuits when the schema declares no properties", () => {
    const empty: JSONSchemaObject = { type: "object", properties: {} };
    expect(validateConfig({ anything: "goes" }, empty).valid).toBe(true);
  });

  it("rejects format violations", () => {
    const result = validateConfig({ email: "not-an-email" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain("email");
  });
});
