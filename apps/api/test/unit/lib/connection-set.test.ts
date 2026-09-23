// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { connectionIdSetSchema, connectionSetSchema } from "../../../src/lib/connection-set.ts";

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

  it("refuses an empty set and one past the cap; accepts exactly the cap", () => {
    expect(connectionIdSetSchema.safeParse([]).success).toBe(false);
    const over = Array.from({ length: MAX_CONNECTIONS_PER_INTEGRATION + 1 }, uuid);
    expect(connectionIdSetSchema.safeParse(over).success).toBe(false);
    expect(connectionIdSetSchema.safeParse(over.slice(1)).success).toBe(true);
  });

  it("refuses a non-uuid id", () => {
    expect(connectionIdSetSchema.safeParse(["conn_1"]).success).toBe(false);
  });
});

describe("connectionSetSchema with a free-form id", () => {
  const overrideSet = connectionSetSchema(z.string().min(1));

  it("accepts any non-empty id and refuses an empty one", () => {
    expect(overrideSet.safeParse(["conn_1", "conn_2"]).data).toEqual(["conn_1", "conn_2"]);
    expect(overrideSet.safeParse([""]).success).toBe(false);
  });
});
