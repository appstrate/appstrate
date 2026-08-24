// SPDX-License-Identifier: Apache-2.0

/**
 * The wiring around `initialRunDetailTab` / `effectiveRunDetailTab`. The pure
 * functions have their own suite (`lib/test/run-detail-tabs.test.ts`); what is
 * covered here is the part that was untested and wrong — WHEN the default is
 * captured, and what the address bar is left holding.
 *
 * Same no-DOM harness as the other component suites: `renderToStaticMarkup`
 * runs the render path (state initialisers and the render-phase capture
 * included) but neither effects nor re-renders — and a component's hook state
 * does NOT survive a parent's render-phase update in this renderer (measured:
 * the child's `useState` initialiser simply runs again). So the two behaviours
 * that need a second render — the capture being FROZEN once taken, and the
 * retired-hash rewrite TERMINATING — are not observable here at all.
 *
 * They are not pinned on source text either: `expect(SOURCE).toContain(…)` is
 * satisfied by any file that happens to hold the string, fails on a rename, and
 * proves nothing about the behaviour. Both decisions live in pure functions
 * beside `effectiveRunDetailTab` instead (`capturedRunDetailTab`,
 * `runDetailTabHashRewrite`) and are tested as functions.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { RunDetailTabsController } from "../run-detail-tabs-controller.tsx";
import {
  RUN_DETAIL_TAB_HASHES,
  capturedRunDetailTab,
  effectiveRunDetailTab,
  runDetailTabHashRewrite,
  type RunDetailTabHash,
  type RunTabAvailability,
} from "../../lib/run-detail-tabs.ts";

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
  it("renders the pane that absorbed the retired hash", () => {
    expect(activeTab(NOTHING, { memorySettled: true, hash: "#deliverable" })).toBe("outcome");
    expect(activeTab(NOTHING, { memorySettled: true, hash: "#logs" })).toBe("execution");
  });

  it("rewrites the address bar to the canonical tab, and terminates", () => {
    // Rendering the right pane is not enough: the user copies the URL they see,
    // and a dead `#logs` keeps propagating. `setActiveTab` navigates with
    // `replace: true` (see `use-tab-with-hash.ts`), so back still leaves the page.
    expect(runDetailTabHashRewrite("logs")).toBe("execution");
    expect(runDetailTabHashRewrite("deliverable")).toBe("outcome");
    // Termination is the property that matters: the rewrite runs from an
    // effect, and an effect that rewrites the URL is exactly the construct
    // that loops in production. It stops because the mapping is idempotent —
    // f(f(x)) === f(x) — so whatever it rewrites TO asks for no further
    // rewrite, for every hash the URL is allowed to carry.
    for (const hash of RUN_DETAIL_TAB_HASHES) {
      const effective = effectiveRunDetailTab(hash);
      expect(effectiveRunDetailTab(effective)).toBe(effective);
      expect(runDetailTabHashRewrite(effective as RunDetailTabHash)).toBeUndefined();
    }
  });

  it("leaves a canonical hash alone rather than rewriting it to itself", () => {
    for (const tab of ["outcome", "files", "execution", "configuration"] as const) {
      expect(runDetailTabHashRewrite(tab)).toBeUndefined();
    }
  });

  it("leaves a live hash alone", () => {
    expect(activeTab(NOTHING, { memorySettled: true, hash: "#configuration" })).toBe(
      "configuration",
    );
  });
});
