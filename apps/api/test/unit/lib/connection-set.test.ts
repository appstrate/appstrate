// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import {
  connectionIdSetSchema,
  nonEmptyConnectionIdSetSchema,
} from "../../../src/lib/connection-set.ts";

const uuid = () => crypto.randomUUID();

describe("connectionIdSetSchema", () => {
  it("keeps the caller's order and lowercases every id", () => {
    const [a, b] = [uuid(), uuid()];
    const parsed = connectionIdSetSchema.safeParse([b.toUpperCase(), a]);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual([b, a]);
  });

  it("refuses a repeat, including one that differs only in case", () => {
    const a = uuid();
    expect(connectionIdSetSchema.safeParse([a, a]).success).toBe(false);
    const folded = connectionIdSetSchema.safeParse([a, a.toUpperCase()]);
    expect(folded.success).toBe(false);
    expect(folded.error?.issues[0]?.message).toMatch(/repeat/);
  });

  it("accepts an empty set (explicitly none) and exactly the cap; refuses one past it", () => {
    const empty = connectionIdSetSchema.safeParse([]);
    expect(empty.success).toBe(true);
    expect(empty.data).toEqual([]);
    const over = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION + 1 }, uuid);
    expect(connectionIdSetSchema.safeParse(over).success).toBe(false);
    expect(connectionIdSetSchema.safeParse(over.slice(1)).success).toBe(true);
  });

  it("refuses a non-uuid id", () => {
    expect(connectionIdSetSchema.safeParse(["conn_1"]).success).toBe(false);
  });
});

describe("nonEmptyConnectionIdSetSchema", () => {
  it("refuses an empty set; otherwise folds like connectionIdSetSchema", () => {
    expect(nonEmptyConnectionIdSetSchema.safeParse([]).success).toBe(false);
    const a = uuid();
    expect(nonEmptyConnectionIdSetSchema.safeParse([a.toUpperCase()]).data).toEqual([a]);
    expect(nonEmptyConnectionIdSetSchema.safeParse([a, a.toUpperCase()]).success).toBe(false);
    const over = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION + 1 }, uuid);
    expect(nonEmptyConnectionIdSetSchema.safeParse(over).success).toBe(false);
  });
});
