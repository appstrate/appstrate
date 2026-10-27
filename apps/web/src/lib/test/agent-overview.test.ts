// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { latestMemoryDate } from "../agent-overview";

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
