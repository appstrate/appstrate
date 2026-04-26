// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the core `validateConfig` + `deepMergeConfig` helpers.
 *
 * Both run-config code paths (the platform run pipeline and the CLI's
 * local PiRunner path) consume these helpers, so the merge + validate
 * semantics live here as the contract every caller relies on.
 */

import { describe, it, expect } from "bun:test";
import { deepMergeConfig, validateConfig } from "../src/schema-validation.ts";
import type { JSONSchemaObject } from "../src/form.ts";

describe("deepMergeConfig", () => {
  it("preserves siblings at every level — no silent nested-key loss", () => {
    const merged = deepMergeConfig(
      { providers: { gmail: { scopes: ["read"] } } },
      { providers: { slack: { token: "xyz" } } },
    );
    expect(merged).toEqual({
      providers: {
        gmail: { scopes: ["read"] },
        slack: { token: "xyz" },
      },
    });
  });

  it("override wins at the leaf for primitive values", () => {
    expect(deepMergeConfig({ a: 1, b: 2 }, { b: 99 })).toEqual({ a: 1, b: 99 });
  });

  it("arrays are replaced, not concatenated", () => {
    expect(deepMergeConfig({ tags: ["a", "b"] }, { tags: ["c"] })).toEqual({ tags: ["c"] });
  });

  it("explicit null clears an inherited leaf", () => {
    expect(deepMergeConfig({ flag: true }, { flag: null })).toEqual({ flag: null });
  });

  it("undefined values are skipped — to clear, pass null", () => {
    expect(deepMergeConfig({ flag: true }, { flag: undefined })).toEqual({ flag: true });
  });

  it("undefined override returns a fresh shallow copy of base", () => {
    const base = { a: 1 };
    const merged = deepMergeConfig(base, undefined);
    expect(merged).toEqual({ a: 1 });
    expect(merged).not.toBe(base);
  });

  it("override that mixes object → primitive replaces the whole subtree", () => {
    expect(deepMergeConfig({ provider: { kind: "gmail" } }, { provider: "slack" })).toEqual({
      provider: "slack",
    });
  });

  it("does not mutate either argument", () => {
    const base = { a: { b: 1 } };
    const override = { a: { c: 2 } };
    const merged = deepMergeConfig(base, override);
    expect(merged).toEqual({ a: { b: 1, c: 2 } });
    expect(base).toEqual({ a: { b: 1 } });
    expect(override).toEqual({ a: { c: 2 } });
  });
});

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
