// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import * as module_ from "../run-detail-tabs";
import { RUN_DETAIL_TABS, initialRunDetailTab, type RunTabAvailability } from "../run-detail-tabs";

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

  it("exports no hash vocabulary beyond the live panes", () => {
    // The module used to export RUN_DETAIL_TAB_HASHES — the live tabs plus six
    // retired ones — alongside a mapping function and an address-bar rewrite.
    // The tab list IS the hash list now, which is what makes the URL contract
    // one thing rather than two that can disagree.
    expect(Object.keys(module_)).toEqual(
      expect.not.arrayContaining([
        "RUN_DETAIL_TAB_HASHES",
        "effectiveRunDetailTab",
        "runDetailTabHashRewrite",
      ]),
    );
  });
});

describe("retired tab hashes", () => {
  /**
   * `#deliverable`, `#result`, `#memory`, `#logs`, `#info` and `#documents`
   * were every other hash this page has ever put in a URL, each mapped onto
   * the pane that absorbed it. They no longer resolve.
   *
   * Asserted rather than deleted with the mapping, because the consequence is
   * silent: such a link opens the default pane and nothing says why. A test
   * that merely disappeared would leave nothing recording that this was
   * decided rather than overlooked.
   */
  const RETIRED = ["deliverable", "result", "memory", "logs", "info", "documents"];

  it("are not part of the tab vocabulary any more", () => {
    for (const hash of RETIRED) {
      expect(RUN_DETAIL_TABS).not.toContain(hash as never);
    }
    // Positive control: the live panes ARE in it, so this cannot pass against
    // an empty list.
    expect([...RUN_DETAIL_TABS]).toHaveLength(4);
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
