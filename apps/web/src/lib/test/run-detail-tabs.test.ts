// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RUN_DETAIL_TABS,
  effectiveRunDetailTab,
  initialRunDetailTab,
  preserveInitialRunDetailTab,
} from "../run-detail-tabs";

const available = (
  overrides: Partial<{ hasDeliverable: boolean; hasResult: boolean; hasMemory: boolean }> = {},
) => ({
  hasDeliverable: false,
  hasResult: false,
  hasMemory: false,
  ...overrides,
});
const runDetailSource = readFileSync(
  fileURLToPath(new URL("../../pages/run-detail.tsx", import.meta.url)),
  "utf8",
);

describe("run detail tabs", () => {
  it("registers the deliverable hash", () => {
    expect(RUN_DETAIL_TABS).toContain("deliverable");
  });

  it("associates every trigger value with a Radix tabpanel", () => {
    for (const tab of RUN_DETAIL_TABS) {
      expect(runDetailSource).toContain(`<TabsContent value="${tab}"`);
    }
    expect(runDetailSource).toMatch(/<Tabs[\s\S]*<TabsList[\s\S]*<TabsContent[\s\S]*<\/Tabs>/);
  });

  it("defaults to deliverable, then result, then logs", () => {
    expect(initialRunDetailTab(available({ hasDeliverable: true, hasResult: true }))).toBe(
      "deliverable",
    );
    expect(initialRunDetailTab(available({ hasResult: true }))).toBe("result");
    expect(initialRunDetailTab(available())).toBe("logs");
  });

  it("does not steal focus when a primary document arrives later", () => {
    expect(preserveInitialRunDetailTab("logs", true, available({ hasDeliverable: true }))).toBe(
      "logs",
    );
  });

  it("waits for the first resolved run before freezing the default", () => {
    expect(preserveInitialRunDetailTab(null, false, available())).toBeNull();
    expect(
      preserveInitialRunDetailTab(null, true, available({ hasDeliverable: true, hasResult: true })),
    ).toBe("deliverable");
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
