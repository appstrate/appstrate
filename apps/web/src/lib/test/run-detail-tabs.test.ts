// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { RUN_DETAIL_TABS, effectiveRunDetailTab, initialRunDetailTab } from "../run-detail-tabs";

const available = (
  overrides: Partial<{
    isActive: boolean;
    isSuccessful: boolean;
    hasResults: boolean;
  }> = {},
) => ({
  isActive: false,
  isSuccessful: false,
  hasResults: false,
  ...overrides,
});
describe("run detail tabs", () => {
  it("exposes exactly Execution and Results", () => {
    expect(RUN_DETAIL_TABS).toEqual(["execution", "results"]);
  });

  it("opens successful runs with production on Results", () => {
    expect(initialRunDetailTab(available({ isSuccessful: true, hasResults: true }))).toBe(
      "results",
    );
  });

  it("opens active, failed, cancelled, and empty successful runs on Execution", () => {
    expect(initialRunDetailTab(available({ isActive: true }))).toBe("execution");
    expect(initialRunDetailTab(available())).toBe("execution");
    expect(initialRunDetailTab(available({ isSuccessful: true }))).toBe("execution");
  });

  it("keeps Results disabled while a run is active", () => {
    expect(effectiveRunDetailTab("results", available({ isActive: true }))).toBe("execution");
    expect(effectiveRunDetailTab("results", available({ hasResults: true }))).toBe("results");
  });
});
