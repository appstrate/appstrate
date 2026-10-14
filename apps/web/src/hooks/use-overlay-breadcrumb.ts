// SPDX-License-Identifier: Apache-2.0

import { useLocation } from "react-router-dom";
import { useOverlayPath } from "../lib/modal-route";
import {
  useBreadcrumb,
  type BreadcrumbEntry,
  type BreadcrumbLayer,
} from "../stores/breadcrumb-store";

/**
 * The header trail of a routed overlay (settings, preferences, catalogue): it
 * names the overlay, not the screen floating underneath, whose own trail shows
 * again once the overlay closes.
 */
export function useOverlayBreadcrumb(entries: BreadcrumbEntry[]) {
  useBreadcrumb("overlay", entries);
}

/**
 * The layer a page's trail belongs to. The page tree renders the screen beneath
 * an open overlay at that screen's own location, so only a page inside the
 * overlay sits at the overlay's path, and its trail extends the overlay's.
 */
export function pageBreadcrumbLayer(pathname: string, overlayPath: string | null): BreadcrumbLayer {
  return overlayPath === pathname ? "overlayPage" : "page";
}

/** A page's own trail, wherever it is mounted. */
export function usePageBreadcrumb(entries: BreadcrumbEntry[]) {
  useBreadcrumb(pageBreadcrumbLayer(useLocation().pathname, useOverlayPath()), entries);
}
