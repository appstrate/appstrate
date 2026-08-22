// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  RUN_DETAIL_TABS,
  RUN_DETAIL_TAB_HASHES,
  effectiveRunDetailTab,
  initialRunDetailTab,
} from "../run-detail-tabs";

const available = (
  overrides: Partial<{ hasFeaturedFile: boolean; hasResult: boolean; hasMemory: boolean }> = {},
) => ({
  hasFeaturedFile: false,
  hasResult: false,
  hasMemory: false,
  ...overrides,
});
describe("run detail tabs", () => {
  it("no longer has a deliverable tab, but still resolves its hash", () => {
    expect(RUN_DETAIL_TABS).not.toContain("deliverable" as never);
    // Old bookmarks and back-history entries still carry `#deliverable`; the
    // hash stays accepted so it can be redirected rather than dropped.
    expect(RUN_DETAIL_TAB_HASHES).toContain("deliverable");
  });

  it("leads with the file list when the run produced exactly one file", () => {
    expect(initialRunDetailTab(available({ hasFeaturedFile: true, hasResult: true }))).toBe(
      "files",
    );
    expect(initialRunDetailTab(available({ hasResult: true }))).toBe("result");
    expect(initialRunDetailTab(available())).toBe("logs");
  });

  it("sends a retired deliverable link to the tab that lists the run's files", () => {
    // Unconditionally: `files` always renders, so the redirect can never
    // land on a blank pane — including for a run that produced several files
    // (or none), whose list is exactly what the old link was after.
    expect(effectiveRunDetailTab("deliverable", available())).toBe("files");
    expect(effectiveRunDetailTab("deliverable", available({ hasResult: true }))).toBe("files");
    expect(effectiveRunDetailTab("deliverable", available({ hasFeaturedFile: true }))).toBe(
      "files",
    );
  });

  it("clamps unavailable deep links without discarding their requested hash", () => {
    expect(effectiveRunDetailTab("result", available())).toBe("logs");
    expect(effectiveRunDetailTab("result", available({ hasResult: true }))).toBe("result");
    expect(effectiveRunDetailTab("files", available())).toBe("files");
  });

  it("clamps a stale memory hash when the optional trigger is absent", () => {
    expect(effectiveRunDetailTab("memory", available())).toBe("logs");
    expect(effectiveRunDetailTab("memory", available({ hasMemory: true }))).toBe("memory");
  });
});
