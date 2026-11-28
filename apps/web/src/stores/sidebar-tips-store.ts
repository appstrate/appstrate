// SPDX-License-Identifier: Apache-2.0

import { authStore } from "./auth-store";
import { parseDismissedTips } from "../lib/sidebar-tips";
import { LOCAL_STORAGE_KEYS, createLocalStore, jsonCodec } from "@appstrate/ui/local-storage";

/**
 * The getting-started cards a person dismissed, per browser and per user (two accounts on one
 * browser each keep theirs), shared by every tab of the browser. Bound to the signed-in user for as
 * long as the module lives, so no component ever reads the unbound default.
 */
export const dismissedTipsStore = createLocalStore(
  LOCAL_STORAGE_KEYS.sidebarTips,
  jsonCodec(parseDismissedTips),
);

dismissedTipsStore.bind(authStore.getState().user?.id ?? null);
authStore.subscribe((state) => dismissedTipsStore.bind(state.user?.id ?? null));
