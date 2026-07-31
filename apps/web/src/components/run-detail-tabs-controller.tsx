// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import {
  RUN_DETAIL_TABS,
  effectiveRunDetailTab,
  initialRunDetailTab,
  type RunDetailTab,
  type RunTabAvailability,
} from "../lib/run-detail-tabs";

/**
 * Owns the URL-backed run tab selection. This component mounts only after the
 * run has resolved, so its lazy state captures the correct initial priority once
 * and does not change when realtime publication adds a primary document later.
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
  const [requestedTab, setActiveTab] = useTabWithHash(RUN_DETAIL_TABS, defaultTab);
  const activeTab = effectiveRunDetailTab(requestedTab, availability);

  return children({ activeTab, setActiveTab });
}
