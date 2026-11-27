// SPDX-License-Identifier: Apache-2.0

import { parseDismissedTips } from "../lib/sidebar-tips";
import { createKeyedLocalStore } from "./local-storage";

/**
 * The getting-started cards a person dismissed, per browser and per user id (two accounts on one
 * browser each keep theirs), shared by every tab of the browser.
 */
export const dismissedTipsStore = createKeyedLocalStore(
  "appstrate-sidebar-tips:",
  parseDismissedTips,
  [],
);
