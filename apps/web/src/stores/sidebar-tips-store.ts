// SPDX-License-Identifier: Apache-2.0

import { parseDismissedTips } from "../lib/sidebar-tips";
import { LOCAL_STORAGE_KEYS, createLocalStore, jsonCodec } from "@appstrate/ui/local-storage";

/**
 * The getting-started cards a person dismissed, per browser and per user id (two accounts on one
 * browser each keep theirs), shared by every tab of the browser.
 */
export const dismissedTipsStore = createLocalStore(
  LOCAL_STORAGE_KEYS.sidebarTips,
  jsonCodec(parseDismissedTips),
);
