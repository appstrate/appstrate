// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { latestMemoryDate, runSuccessRate } from "../agent-overview";

describe("runSuccessRate", () => {
  it("is null before any run has finished", () => {
    expect(runSuccessRate({ success: 0, failed: 0, timeout: 0 })).toBeNull();
  });

  it("counts timeouts as failures", () => {
    expect(runSuccessRate({ success: 3, failed: 0, timeout: 1 })).toBe(0.75);
    expect(runSuccessRate({ success: 1, failed: 1, timeout: 2 })).toBe(0.25);
  });
});

describe("latestMemoryDate", () => {
  it("is undefined with nothing written", () => {
    expect(latestMemoryDate([], [])).toBeUndefined();
    expect(latestMemoryDate([{ updatedAt: null, createdAt: null }], [{ createdAt: null }])).toBe(
      undefined,
    );
  });

  it("takes a pinned slot's update over its creation", () => {
    expect(
      latestMemoryDate(
        [{ createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" }],
        [{ createdAt: "2026-02-01T00:00:00Z" }],
      ),
    ).toBe("2026-03-01T00:00:00Z");
  });

  it("compares instants, not strings, across both tiers", () => {
    expect(
      latestMemoryDate(
        [{ createdAt: "2026-02-01T10:00:00+02:00", updatedAt: null }],
        [{ createdAt: "2026-02-01T09:00:00Z" }],
      ),
    ).toBe("2026-02-01T09:00:00Z");
  });
});
