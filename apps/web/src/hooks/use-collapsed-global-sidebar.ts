// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { useSidebarStore } from "../stores/sidebar-store";

/**
 * Collapse the global sidebar for as long as the calling route is mounted, and
 * restore whatever it was on leave. Routes with their own secondary sidebar
 * (settings, chat) need the room.
 *
 * `setOpenTransient` deliberately does not write the persisted preference: the
 * collapse belongs to the route, not to the user's choice, so leaving the route
 * must give the user back exactly the sidebar they had.
 */
export function useCollapsedGlobalSidebar(): void {
  useEffect(() => {
    const { open, setOpenTransient } = useSidebarStore.getState();
    const prev = open;
    setOpenTransient(false);
    return () => {
      useSidebarStore.getState().setOpenTransient(prev);
    };
  }, []);
}
