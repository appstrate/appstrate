// SPDX-License-Identifier: Apache-2.0

import { authStore } from "../stores/auth-store";
import { orgStore } from "../stores/org-store";
import { spaceStore } from "../stores/space-store";
import { exitViewAs } from "../stores/view-as-store";
import { queryClient } from "./query-client";

/**
 * Centralized session teardown. Resets the auth store AND the org/space scope
 * so a subsequent login can never carry over a stale `X-Org-Id` / `X-Space-Id`
 * header from the previous user — the scoping-header builder reads straight off
 * these stores. The space each account last left an organization in stays
 * remembered: it is keyed by user, and a candidate `useSpaceResolver` only
 * promotes once that user's own space list proves it enterable.
 */
export function clearSession(): void {
  authStore.setState({ user: null, profile: null, loading: false });
  // Every cached answer belongs to the session that just ended.
  queryClient.clear();
  orgStore.getState().setId(null);
  spaceStore.getState().setId(null);
  // Same reason, one scope deeper: a persona left behind would ride the next
  // user's requests as `X-View-As`. Here rather than at the sign-out button —
  // the OIDC branch navigates away before anything after `logout()` runs, and
  // a session lost mid-flight never passes through a button at all.
  exitViewAs();
}
