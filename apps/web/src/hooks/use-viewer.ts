// SPDX-License-Identifier: Apache-2.0

import { useStore } from "zustand";
import { authStore } from "../stores/auth-store";
import type { SpaceViewer } from "../lib/identity-tile-props";

/**
 * The signed-in person as the UI names and draws them; null while no session is known.
 *
 * A read of the auth store, kept out of `use-auth.ts`: that module builds the Better Auth client
 * (which needs the page's origin) and registers the session check at import, so any component
 * that only needs to name the viewer would drag both into its import chain.
 */
export function useViewer(): SpaceViewer | null {
  const user = useStore(authStore, (s) => s.user);
  const displayName = useStore(authStore, (s) => s.profile?.displayName);
  return user ? { id: user.id, name: displayName || user.email } : null;
}
