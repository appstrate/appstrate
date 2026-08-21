// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  runMetadataSchema,
  runLogDataSchema,
  packagePersistenceContentSchema,
  scheduleInputSchema,
} from "../../src/lib/jsonb-schemas.ts";

const KB = 1024;

/**
 * Build a JSON object whose `JSON.stringify` length exceeds `targetBytes`.
 * Each key is `kN` (≥2 bytes) and the value is a 1-byte numeric, so the
 * stringified record grows linearly.
 */
function payloadLargerThan(targetBytes: number): Record<string, number> {
  const obj: Record<string, number> = {};
  let i = 0;
  while (Buffer.byteLength(JSON.stringify(obj), "utf8") <= targetBytes) {
    obj[`k${i++}`] = 1;
  }
  return obj;
}

describe("scheduleInputSchema", () => {
  it("accepts an empty object", () => {
    expect(scheduleInputSchema.safeParse({}).success).toBe(true);
  });

  it("accepts arbitrary nested JSON", () => {
    expect(
      scheduleInputSchema.safeParse({ query: "users", filters: { active: true, age: [18, 99] } })
        .success,
    ).toBe(true);
  });

  it("accepts payloads under the 16 KB cap", () => {
    expect(scheduleInputSchema.safeParse(payloadLargerThan(8 * KB)).success).toBe(true);
  });

  it("rejects payloads larger than the 16 KB cap", () => {
    const result = scheduleInputSchema.safeParse(payloadLargerThan(16 * KB));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/max is 16384/);
  });

  it("rejects non-JSON values (Date, function) at any nesting level", () => {
    expect(scheduleInputSchema.safeParse({ when: new Date() }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ fn: () => null }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ nested: { d: new Date() } }).success).toBe(false);
  });

  it("rejects non-finite numbers (NaN / Infinity)", () => {
    expect(scheduleInputSchema.safeParse({ x: NaN }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ x: Infinity }).success).toBe(false);
  });

  it("rejects undefined values inside arrays", () => {
    // JSON.stringify silently drops `undefined` in arrays — schema must reject
    // up front so the rejection is visible at the write boundary.
    expect(scheduleInputSchema.safeParse({ list: [1, undefined, 3] }).success).toBe(false);
  });
});

describe("runMetadataSchema (regression — 8 KB cap)", () => {
  it("rejects payloads larger than 8 KB", () => {
    expect(runMetadataSchema.safeParse(payloadLargerThan(8 * KB)).success).toBe(false);
  });
});

describe("runLogDataSchema (regression — 32 KB cap)", () => {
  it("rejects payloads larger than 32 KB", () => {
    expect(runLogDataSchema.safeParse(payloadLargerThan(32 * KB)).success).toBe(false);
  });
});

describe("packagePersistenceContentSchema (regression — 64 KB cap, any JSON value)", () => {
  it("accepts a plain string (note() tool path)", () => {
    expect(packagePersistenceContentSchema.safeParse("a memory note").success).toBe(true);
  });

  it("accepts a structured object (checkpoint / pinned slot)", () => {
    expect(packagePersistenceContentSchema.safeParse({ key: "value", n: 1 }).success).toBe(true);
  });

  it("rejects payloads larger than 64 KB", () => {
    expect(packagePersistenceContentSchema.safeParse(payloadLargerThan(64 * KB)).success).toBe(
      false,
    );
  });
});
