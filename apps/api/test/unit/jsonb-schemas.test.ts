// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  runLogDataSchema,
  packagePersistenceContentSchema,
  scheduleInputSchema,
  inputSettingsSchema,
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

describe("inputSettingsSchema (16 KB cap)", () => {
  it("accepts the column's empty default", () => {
    expect(inputSettingsSchema.safeParse({ values: {}, locked: [] }).success).toBe(true);
  });

  it("accepts a fat but realistic document", () => {
    // A 25-field agent whose longest field holds a 4 KB instruction template,
    // every field locked: 6 630 bytes, i.e. 2.4× of headroom under the cap.
    // File-typed fields never contribute bytes — the schema form stores an
    // `upload://upl_…` URI (~40 bytes), never the file itself.
    const values: Record<string, unknown> = { instructions: "x".repeat(4 * KB) };
    for (let i = 0; i < 24; i++) values[`field_${i}`] = "some short default value";
    const result = inputSettingsSchema.safeParse({ values, locked: Object.keys(values) });
    expect(result.success).toBe(true);
  });

  it("rejects a document larger than the 16 KB cap", () => {
    const result = inputSettingsSchema.safeParse({
      values: payloadLargerThan(16 * KB),
      locked: [],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/max is 16384/);
  });

  it("rejects a document blown up by `locked` alone", () => {
    // `locked` is never pruned to the schema's declared properties, so it is
    // an unbounded write vector in its own right, not just a companion to
    // `values`. The cap is on the whole document for exactly that reason.
    const locked = Array.from({ length: 2000 }, (_, i) => `field_name_number_${i}`);
    expect(inputSettingsSchema.safeParse({ values: {}, locked }).success).toBe(false);
  });

  it("rejects non-JSON values and a missing member", () => {
    expect(inputSettingsSchema.safeParse({ values: { d: new Date() }, locked: [] }).success).toBe(
      false,
    );
    expect(inputSettingsSchema.safeParse({ values: {} }).success).toBe(false);
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
