// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type ReactNode } from "react";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import {
  RUN_DETAIL_TAB_HASHES,
  capturedRunDetailTab,
  effectiveRunDetailTab,
  initialRunDetailTab,
  runDetailTabHashRewrite,
  type RunDetailTab,
  type RunTabAvailability,
} from "../lib/run-detail-tabs";

/**
 * Owns the URL-backed run tab selection.
 *
 * The default pane is captured ONCE and then frozen, so a file published while
 * the page is open cannot move the user to another tab mid-read. The capture is
 * deliberately NOT taken on first render: `availability.hasMemory` comes from
 * two persistence queries that resolve independently of the run itself, so at
 * first render a run that only wrote memory still looks like a run that
 * produced nothing — and froze on «Exécution», non-deterministically. It is
 * taken on the first render whose inputs are all settled, which is either:
 *
 *   - immediately, when the run DTO alone already decides it (`hasOutput` or a
 *     produced file means `outcome` whatever memory turns out to hold — both
 *     ride the run resource the page has), or
 *   - once `memorySettled` says the memory queries have answered.
 *
 * Until then the strip renders the answer the settled inputs give on their own
 * (memory treated as empty) — nothing is blocked on the queries. That
 * provisional value is only ever wrong for the memory-only run, and it is
 * corrected the moment the queries land instead of being frozen wrong forever.
 * The capture itself is React's documented render-phase state adjustment
 * (guarded `setCaptured` during render), not an effect: it re-renders before
 * anything is painted, so the provisional value never reaches the screen when
 * the queries were already warm.
 *
 * The hash is validated against `RUN_DETAIL_TAB_HASHES` (live tabs + retired
 * ones), and `effectiveRunDetailTab` maps a retired hash onto the pane that
 * absorbed it — dropping it from the list instead would silently send every old
 * `#deliverable`, `#result` or `#logs` link back to the default tab. A retired
 * hash is also rewritten in the address bar (see below).
 */
export function RunDetailTabsController({
  availability,
  memorySettled,
  children,
}: {
  availability: RunTabAvailability;
  /**
   * The memory queries feeding `availability.hasMemory` have answered (or will
   * never run). Every other field rides the run DTO and is settled by the time
   * this component mounts.
   */
  memorySettled: boolean;
  children: (state: {
    activeTab: RunDetailTab;
    setActiveTab: (tab: RunDetailTab) => void;
  }) => ReactNode;
}) {
  // Which pane is the default, and WHEN that answer is frozen, is
  // `capturedRunDetailTab` — a pure function so both halves are testable
  // without a DOM (this harness renders once; a freeze is not observable in it).
  // The guarded `setCaptured` here is React's documented render-phase
  // adjustment, not an effect: it re-renders before anything is painted, so the
  // provisional value never reaches the screen when the queries were warm.
  const [captured, setCaptured] = useState<RunDetailTab | null>(() =>
    capturedRunDetailTab({ captured: null, availability, memorySettled }),
  );
  const nextCapture = capturedRunDetailTab({ captured, availability, memorySettled });
  if (nextCapture !== captured) {
    setCaptured(nextCapture);
  }

  const defaultTab = captured ?? initialRunDetailTab({ ...availability, hasMemory: false });
  const [requestedTab, setActiveTab] = useTabWithHash(RUN_DETAIL_TAB_HASHES, defaultTab);
  const activeTab = effectiveRunDetailTab(requestedTab);

  // A retired hash renders the right pane but must not stay in the address bar:
  // the user copies what they see, and an old `#documents` would keep
  // propagating a dead anchor. `setActiveTab` navigates with `replace: true`,
  // so this adds no history entry and the back button still leaves the page.
  // The decision — and its TERMINATION, the thing that makes this effect safe —
  // lives in `runDetailTabHashRewrite`.
  const rewriteTo = runDetailTabHashRewrite(requestedTab);
  useEffect(() => {
    if (rewriteTo) setActiveTab(rewriteTo);
  }, [rewriteTo, setActiveTab]);

  return children({ activeTab, setActiveTab });
}
