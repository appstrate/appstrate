// SPDX-License-Identifier: Apache-2.0

import { authStore } from "../stores/auth-store";
import { orgStore } from "../stores/org-store";
import { spaceStore } from "../stores/space-store";
import { exitViewAs } from "../stores/view-as-store";
import { queryClient } from "./query-client";
import { rememberSignedIn } from "./session-read";

/**
 * Session teardown: nothing of the ended session (user, cached answers,
 * org/space scope, persona) may ride the next one's requests.
 */
export function clearSession(): void {
  rememberSignedIn(localStorage, false);
  authStore.setState({ user: null, profile: null, loading: false });
  queryClient.clear();
  orgStore.getState().setId(null);
  spaceStore.getState().setId(null);
  // Here rather than at the sign-out button: the OIDC branch navigates away
  // first, and a session lost mid-flight never passes through a button.
  exitViewAs();
}
