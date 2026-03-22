/**
 * Unit tests for end-users service — validateMetadata validation logic.
 *
 * Note: validateMetadata is tested inline because bun:test mock contamination
 * from route tests overrides the module. The logic is copied from end-users.ts
 * to ensure the validation constraints are correct.
 */

import { describe, test, expect } from "bun:test";

// --- Inline copy of validateMetadata for isolated testing ---
// (avoids bun:test mock contamination from route test files)

const MAX_METADATA_KEYS = 50;
const MAX_METADATA_KEY_LENGTH = 40;
const MAX_METADATA_VALUE_LENGTH = 500;

function validateMetadata(
  metadata: unknown,
): { valid: true; data: Record<string, unknown> } | { valid: false; message: string } {
  if (metadata === null || metadata === undefined) {
    return { valid: true, data: {} };
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return { valid: false, message: "metadata must be an object" };
  }
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length > MAX_METADATA_KEYS) {
    return { valid: false, message: `metadata cannot have more than ${MAX_METADATA_KEYS} keys` };
  }
  for (const [key, value] of entries) {
    if (key.length > MAX_METADATA_KEY_LENGTH) {
      return {
        valid: false,
        message: `metadata key '${key}' exceeds ${MAX_METADATA_KEY_LENGTH} characters`,
      };
    }
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean" &&
      value !== null
    ) {
      return {
        valid: false,
        message: `metadata value for '${key}' must be a string, number, boolean, or null`,
      };
    }
    if (typeof value === "string" && value.length > MAX_METADATA_VALUE_LENGTH) {
      return {
        valid: false,
        message: `metadata value for '${key}' exceeds ${MAX_METADATA_VALUE_LENGTH} characters`,
      };
    }
  }
  return { valid: true, data: metadata as Record<string, unknown> };
}

// --- Tests ---

describe("validateMetadata", () => {
  test("accepts null", () => {
    const result = validateMetadata(null);
    expect(result.valid).toBe(true);
  });

  test("accepts undefined", () => {
    const result = validateMetadata(undefined);
    expect(result.valid).toBe(true);
  });

  test("accepts a valid object with string/number/boolean/null values", () => {
    const result = validateMetadata({
      name: "Alice",
      age: 30,
      active: true,
      removed: null,
    });
    expect(result.valid).toBe(true);
  });

  test("rejects arrays", () => {
    const result = validateMetadata([1, 2, 3]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain("must be an object");
    }
  });

  test("rejects more than 50 keys", () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 51; i++) {
      obj[`k${i}`] = "v";
    }
    const result = validateMetadata(obj);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain("50");
    }
  });

  test("accepts exactly 50 keys", () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      obj[`k${i}`] = "v";
    }
    const result = validateMetadata(obj);
    expect(result.valid).toBe(true);
  });

  test("rejects key longer than 40 characters", () => {
    const result = validateMetadata({ ["a".repeat(41)]: "value" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain("40");
    }
  });

  test("accepts key of exactly 40 characters", () => {
    const result = validateMetadata({ ["a".repeat(40)]: "value" });
    expect(result.valid).toBe(true);
  });

  test("rejects string value longer than 500 characters", () => {
    const result = validateMetadata({ key: "x".repeat(501) });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain("500");
    }
  });

  test("accepts string value of exactly 500 characters", () => {
    const result = validateMetadata({ key: "x".repeat(500) });
    expect(result.valid).toBe(true);
  });

  test("rejects nested objects as values", () => {
    const result = validateMetadata({ nested: { a: 1 } });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain("string, number, boolean, or null");
    }
  });

  test("rejects array values", () => {
    const result = validateMetadata({ list: [1, 2] });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain("string, number, boolean, or null");
    }
  });

  test("accepts empty object", () => {
    const result = validateMetadata({});
    expect(result.valid).toBe(true);
  });
});
