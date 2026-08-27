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
  it("exposes exactly Journal and Results", () => {
    expect(RUN_DETAIL_TABS).toEqual(["journal", "results"]);
  });

  it("opens active runs on Journal", () => {
    expect(initialRunDetailTab(available({ isActive: true }))).toBe("journal");
  });

  it("opens completed runs with durable production on Results", () => {
    expect(initialRunDetailTab(available({ hasResults: true }))).toBe("results");
  });

  it("opens failed runs and terminal runs without production on Journal", () => {
    expect(initialRunDetailTab(available())).toBe("journal");
    expect(initialRunDetailTab(available({ isFailed: true, hasResults: true }))).toBe("journal");
  });

  it("keeps Results unavailable without durable production", () => {
    expect(effectiveRunDetailTab("results", available({ isActive: true }))).toBe("journal");
    expect(effectiveRunDetailTab("results", available())).toBe("journal");
    expect(effectiveRunDetailTab("results", available({ hasResults: true }))).toBe("results");
  });

  it("respects an explicit valid tab over the lifecycle default", () => {
    expect(effectiveRunDetailTab("journal", available({ hasResults: true }))).toBe("journal");
    expect(effectiveRunDetailTab("results", available({ isFailed: true, hasResults: true }))).toBe(
      "results",
    );
  });
});
