// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { RUN_DETAIL_TABS, effectiveRunDetailTab, initialRunDetailTab } from "../run-detail-tabs";

const available = (
  overrides: Partial<{ hasDeliverable: boolean; hasResult: boolean; hasMemory: boolean }> = {},
) => ({
  hasDeliverable: false,
  hasResult: false,
  hasMemory: false,
  ...overrides,
});
describe("run detail tabs", () => {
  it("registers the deliverable hash", () => {
    expect(RUN_DETAIL_TABS).toContain("deliverable");
  });

  it("defaults to deliverable, then result, then logs", () => {
    expect(initialRunDetailTab(available({ hasDeliverable: true, hasResult: true }))).toBe(
      "deliverable",
    );
    expect(initialRunDetailTab(available({ hasResult: true }))).toBe("result");
    expect(initialRunDetailTab(available())).toBe("logs");
  });

  it("clamps unavailable deep links without discarding their requested hash", () => {
    expect(effectiveRunDetailTab("deliverable", available({ hasResult: true }))).toBe("result");
    expect(effectiveRunDetailTab("deliverable", available())).toBe("logs");
    expect(effectiveRunDetailTab("deliverable", available({ hasDeliverable: true }))).toBe(
      "deliverable",
    );
    expect(effectiveRunDetailTab("result", available({ hasDeliverable: true }))).toBe("logs");
  });

  it("clamps a stale memory hash when the optional trigger is absent", () => {
    expect(effectiveRunDetailTab("memory", available())).toBe("logs");
    expect(effectiveRunDetailTab("memory", available({ hasMemory: true }))).toBe("memory");
  });
});
