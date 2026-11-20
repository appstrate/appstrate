// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { computeState, usedComputeMinutes } from "../billing-compute.ts";

describe("usedComputeMinutes", () => {
  it("shows whole minutes, rounded down", () => {
    expect(usedComputeMinutes({ used_seconds: 0 })).toBe(0);
    expect(usedComputeMinutes({ used_seconds: 59 })).toBe(0);
    expect(usedComputeMinutes({ used_seconds: 60 })).toBe(1);
    expect(usedComputeMinutes({ used_seconds: 24_700 })).toBe(411);
  });
});

describe("computeState", () => {
  it("has nothing to gauge without a compute quota", () => {
    expect(computeState({ included_minutes: null, usage_percent: 0 })).toBe("none");
  });

  it("is ok below 80 %, a warning from 80 %, exhausted at 100 %", () => {
    expect(computeState({ included_minutes: 1000, usage_percent: 79 })).toBe("ok");
    expect(computeState({ included_minutes: 1000, usage_percent: 80 })).toBe("warning");
    expect(computeState({ included_minutes: 1000, usage_percent: 99 })).toBe("warning");
    expect(computeState({ included_minutes: 1000, usage_percent: 100 })).toBe("exhausted");
  });
});
