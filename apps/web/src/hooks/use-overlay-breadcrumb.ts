// SPDX-License-Identifier: Apache-2.0

import { useBreadcrumb, type BreadcrumbEntry } from "../stores/breadcrumb-store";

/**
 * The header trail of a routed overlay (settings, preferences, catalogue): it
 * names the overlay, not the screen floating underneath, whose own trail shows
 * again once the overlay closes.
 */
export function useOverlayBreadcrumb(entries: BreadcrumbEntry[]) {
  useBreadcrumb("overlay", entries);
}

/** A page's own trail. */
export function usePageBreadcrumb(entries: BreadcrumbEntry[]) {
  useBreadcrumb("page", entries);
}
