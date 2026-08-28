// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { RUN_DETAIL_TABS, effectiveRunDetailTab, initialRunDetailTab } from "../run-detail-tabs";

const available = (
  overrides: Partial<{
    isActive: boolean;
    isFailed: boolean;
    hasResults: boolean;
  }> = {},
) => ({
  isActive: false,
  isFailed: false,
  hasResults: false,
  ...overrides,
});
describe("run detail tabs", () => {
  it("exposes Overview first, followed by Journal and Results", () => {
    expect(RUN_DETAIL_TABS).toEqual(["overview", "journal", "results"]);
  });

  it("opens every run lifecycle on Overview", () => {
    expect(initialRunDetailTab(available({ isActive: true }))).toBe("overview");
    expect(initialRunDetailTab(available({ hasResults: true }))).toBe("overview");
    expect(initialRunDetailTab(available({ isFailed: true, hasResults: true }))).toBe("overview");
  });

  it("keeps Results addressable throughout the run lifecycle", () => {
    expect(effectiveRunDetailTab("results", available({ isActive: true }))).toBe("results");
    expect(effectiveRunDetailTab("results", available())).toBe("results");
    expect(effectiveRunDetailTab("results", available({ hasResults: true }))).toBe("results");
  });

  it("respects an explicit valid tab over the lifecycle default", () => {
    expect(effectiveRunDetailTab("journal", available({ hasResults: true }))).toBe("journal");
    expect(effectiveRunDetailTab("results", available({ isFailed: true, hasResults: true }))).toBe(
      "results",
    );
    expect(effectiveRunDetailTab("overview", available({ isActive: true }))).toBe("overview");
  });
});
