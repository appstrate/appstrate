// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  RUN_DETAIL_TABS,
  RUN_DETAIL_TAB_HASHES,
  effectiveRunDetailTab,
  initialRunDetailTab,
  type RunDetailTabHash,
  type RunTabAvailability,
} from "../run-detail-tabs";

const available = (overrides: Partial<RunTabAvailability> = {}): RunTabAvailability => ({
  producedFileCount: 0,
  hasOutput: false,
  hasMemory: false,
  ...overrides,
});

describe("run detail tabs", () => {
  it("is the four panes of the restructured page, and nothing else", () => {
    expect([...RUN_DETAIL_TABS]).toEqual(["outcome", "files", "execution", "configuration"]);
  });

  it("renders every pane for every run, so no hash can land on a missing tab", () => {
    // The old set gated `result` and `memory` on their content; a deep link to
    // either had to be bounced elsewhere. Nothing is gated any more, which is
    // what lets `effectiveRunDetailTab` be a pure hash mapping.
    for (const tab of RUN_DETAIL_TABS) {
      expect(effectiveRunDetailTab(tab)).toBe(tab);
    }
  });
});

describe("retired tab hashes", () => {
  /**
   * Every hash the page has ever put in a URL. Each one is still out there in
   * a bookmark, in back-history, or in a link pasted into an old chat message,
   * and each must resolve to a pane that renders — a hash that stops resolving
   * silently falls back to the default tab, which nobody reports as a bug.
   */
  const RETIRED: Record<string, string> = {
    // The single featured output, and the `output` tool's value: both are
    // sections of Outcome now.
    deliverable: "outcome",
    result: "outcome",
    // Memory is something the run produced, so it moved with the rest.
    memory: "outcome",
    // Both described how the run ran.
    logs: "execution",
    info: "execution",
  };

  for (const [hash, target] of Object.entries(RETIRED)) {
    it(`sends #${hash} to the live "${target}" pane`, () => {
      expect(RUN_DETAIL_TAB_HASHES).toContain(hash as RunDetailTabHash);
      expect(RUN_DETAIL_TABS).not.toContain(hash as never);

      const resolved = effectiveRunDetailTab(hash as RunDetailTabHash);
      expect(resolved).toBe(target as never);
      // The redirect target is a LIVE tab — never another retired hash.
      expect(RUN_DETAIL_TABS).toContain(resolved);
    });
  }

  it("accepts every retired hash regardless of what the run holds", () => {
    // Unconditionally: all four panes render, so a redirect can never land on
    // a blank pane — including for a run that produced nothing at all.
    for (const hash of Object.keys(RETIRED)) {
      expect(RUN_DETAIL_TABS).toContain(effectiveRunDetailTab(hash as RunDetailTabHash));
    }
  });
});

describe("initial tab", () => {
  it("leads with Outcome for a run that produced exactly one file", () => {
    expect(initialRunDetailTab(available({ producedFileCount: 1 }))).toBe("outcome");
  });

  it("leads with Outcome for a run that produced several files", () => {
    // Several files are listed, none is featured — but they are still what the
    // run produced, so Outcome is still the pane the page opens on.
    expect(initialRunDetailTab(available({ producedFileCount: 4 }))).toBe("outcome");
  });

  it("leads with Exécution for a run that produced no file and nothing else", () => {
    expect(initialRunDetailTab(available({ producedFileCount: 0 }))).toBe("execution");
  });

  it("still leads with Outcome when the only thing produced is an output or a memory write", () => {
    expect(initialRunDetailTab(available({ hasOutput: true }))).toBe("outcome");
    expect(initialRunDetailTab(available({ hasMemory: true }))).toBe("outcome");
  });
});
