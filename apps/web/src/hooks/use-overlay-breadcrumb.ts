// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { useBreadcrumbStore, type BreadcrumbEntry } from "../stores/breadcrumb-store";

/**
 * The header trail of a routed overlay (settings, preferences, catalogue): it
 * names the overlay, not the screen floating underneath, and the trail that was
 * there comes back when the overlay closes. `null` leaves the trail alone.
 */
export function useOverlayBreadcrumb(entries: BreadcrumbEntry[] | null) {
  const setEntries = useBreadcrumbStore((state) => state.setEntries);
  const before = useRef(useBreadcrumbStore.getState().entries);
  useEffect(() => {
    const previous = before.current;
    return () => setEntries(previous);
  }, [setEntries]);
  const signature = JSON.stringify(entries?.map((entry) => [entry.label, entry.href]));
  useEffect(() => {
    if (entries) setEntries(entries);
    // Keyed on the labels and hrefs: the array is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, setEntries]);
}
