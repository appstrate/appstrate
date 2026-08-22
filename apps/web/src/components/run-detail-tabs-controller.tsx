// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import {
  RUN_DETAIL_TAB_HASHES,
  effectiveRunDetailTab,
  initialRunDetailTab,
  type RunDetailTab,
  type RunTabAvailability,
} from "../lib/run-detail-tabs";

/**
 * Owns the URL-backed run tab selection. This component mounts only after the
 * run has resolved, so its lazy state captures the correct initial priority once
 * and does not change when a file published later makes another tab lead.
 *
 * The hash is validated against `RUN_DETAIL_TAB_HASHES` (live tabs + retired
 * ones), and `effectiveRunDetailTab` maps a retired hash onto the pane that
 * absorbed it — dropping it from the list instead would silently send every old
 * `#deliverable`, `#result` or `#logs` link back to the default tab.
 */
export function RunDetailTabsController({
  availability,
  children,
}: {
  availability: RunTabAvailability;
  children: (state: {
    activeTab: RunDetailTab;
    setActiveTab: (tab: RunDetailTab) => void;
  }) => ReactNode;
}) {
  const [defaultTab] = useState(() => initialRunDetailTab(availability));
  const [requestedTab, setActiveTab] = useTabWithHash(RUN_DETAIL_TAB_HASHES, defaultTab);
  const activeTab = effectiveRunDetailTab(requestedTab);

  return children({ activeTab, setActiveTab });
}
