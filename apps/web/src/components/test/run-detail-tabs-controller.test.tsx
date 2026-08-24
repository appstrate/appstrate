// SPDX-License-Identifier: Apache-2.0

/**
 * The wiring around `initialRunDetailTab`. The pure functions have their own
 * suite (`lib/test/run-detail-tabs.test.ts`); what is covered here is the part
 * that was untested and wrong — WHEN the default is captured.
 *
 * Same no-DOM harness as the other component suites: `renderToStaticMarkup`
 * runs the render path (state initialisers and the render-phase capture
 * included) but neither effects nor re-renders — and a component's hook state
 * does NOT survive a parent's render-phase update in this renderer (measured:
 * the child's `useState` initialiser simply runs again). So the behaviour that
 * needs a second render — the capture being FROZEN once taken — is not
 * observable here at all.
 *
 * It is not pinned on source text either: `expect(SOURCE).toContain(…)` is
 * satisfied by any file that happens to hold the string, fails on a rename, and
 * proves nothing about the behaviour. That decision lives in a pure function
 * (`capturedRunDetailTab`) and is tested as one.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { RunDetailTabsController } from "../run-detail-tabs-controller.tsx";
import { capturedRunDetailTab, type RunTabAvailability } from "../../lib/run-detail-tabs.ts";

/** The tab the controller hands its children, for a given URL + inputs. */
function activeTab(
  availability: RunTabAvailability,
  opts: { memorySettled: boolean; hash?: string },
): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/agents/@a/b/runs/run_1${opts.hash ?? ""}`]}>
      <RunDetailTabsController availability={availability} memorySettled={opts.memorySettled}>
        {({ activeTab: tab }) => <span>{tab}</span>}
      </RunDetailTabsController>
    </MemoryRouter>,
  ).replace(/<\/?span>/g, "");
}

const NOTHING: RunTabAvailability = {
  producedFileCount: 0,
  hasOutput: false,
  hasMemory: false,
};

describe("the default pane is captured from settled inputs", () => {
  it("leads with Outcome for a memory-only run, once the memory queries answered", () => {
    // The defect: `hasMemory` rides two persistence queries that resolve
    // independently of the run, so a first-render capture froze this run on
    // Exécution — non-deterministically, depending on which request won.
    expect(activeTab({ ...NOTHING, hasMemory: true }, { memorySettled: true })).toBe("outcome");
  });

  it("does not capture from an unsettled memory count", () => {
    // `null` is the whole point: nothing is captured, so a later render can
    // still take the real answer once the queries land.
    expect(
      capturedRunDetailTab({
        captured: null,
        availability: { ...NOTHING, hasMemory: true },
        memorySettled: false,
      }),
    ).toBeNull();
    // Rendering is not blocked meanwhile — the strip shows the answer the
    // settled inputs give on their own, memory treated as empty.
    expect(activeTab({ ...NOTHING, hasMemory: true }, { memorySettled: false })).toBe("execution");
  });

  it("captures immediately when the run DTO alone decides the answer", () => {
    // `hasOutput` and `producedFileCount` both ride the run resource this
    // component mounts on; memory cannot change an answer that is already
    // `outcome`, so there is nothing to wait for. The rendered tab cannot tell
    // this apart — the provisional fallback answers `outcome` for these inputs
    // too — so what is asserted is that a value was CAPTURED, not merely shown.
    expect(
      capturedRunDetailTab({
        captured: null,
        availability: { ...NOTHING, hasOutput: true },
        memorySettled: false,
      }),
    ).toBe("outcome");
    expect(
      capturedRunDetailTab({
        captured: null,
        availability: { ...NOTHING, producedFileCount: 2 },
        memorySettled: false,
      }),
    ).toBe("outcome");
  });

  it("freezes the captured pane against later availability changes", () => {
    // A file published while the page is open must not move the user to
    // another tab mid-read. Once captured, `availability` is not consulted
    // again — including when it now says the opposite.
    expect(
      capturedRunDetailTab({
        captured: "execution",
        availability: { producedFileCount: 3, hasOutput: true, hasMemory: true },
        memorySettled: true,
      }),
    ).toBe("execution");
    expect(
      capturedRunDetailTab({ captured: "outcome", availability: NOTHING, memorySettled: true }),
    ).toBe("outcome");
  });

  it("leads with Execution for a run that produced nothing at all", () => {
    expect(activeTab(NOTHING, { memorySettled: true })).toBe("execution");
  });
});

describe("retired tab hashes", () => {
  it("falls through to the default pane instead of resolving", () => {
    // `#deliverable` used to render Outcome and `#logs` Execution, each also
    // rewritten in the address bar. Both now behave like any hash the page
    // does not know: the default pane, silently. For a run that produced
    // nothing that default is Execution — so `#logs` LOOKS unchanged here and
    // `#deliverable` is the case that actually distinguishes the two.
    expect(activeTab(NOTHING, { memorySettled: true, hash: "#deliverable" })).toBe("execution");
    expect(activeTab(NOTHING, { memorySettled: true, hash: "#logs" })).toBe("execution");
    // And against a run whose default is Outcome, the retired hash cannot pull
    // the reader to Execution any more either.
    expect(activeTab({ ...NOTHING, hasOutput: true }, { memorySettled: true, hash: "#logs" })).toBe(
      "outcome",
    );
  });

  it("leaves a live hash alone", () => {
    expect(activeTab(NOTHING, { memorySettled: true, hash: "#configuration" })).toBe(
      "configuration",
    );
  });
});
