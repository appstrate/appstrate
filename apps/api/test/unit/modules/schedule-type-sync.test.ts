// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { InferSelectModel } from "drizzle-orm";
import type { Schedule } from "@appstrate/shared-types";
import { packageSchedules } from "../../../src/modules/scheduling/schema.ts";

type SchemaRow = InferSelectModel<typeof packageSchedules>;

// Type-only equality: any key in one set but not the other is reported as
// `never`, making the resulting type a non-empty object that fails to satisfy
// `Record<string, never>`.
type KeyDiff<A, B> = Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>;
type NoKeyDrift = [KeyDiff<Schedule, SchemaRow>] extends [never] ? true : false;

describe("Schedule shared type", () => {
  it("has the same keys as packageSchedules (compile-time guard)", () => {
    const ok: NoKeyDrift = true;
    expect(ok).toBe(true);
  });
});
