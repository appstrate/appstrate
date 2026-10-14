// SPDX-License-Identifier: Apache-2.0

/**
 * Routed modals: surfaces that overlay the current screen but keep a real URL.
 *
 * The alternative — a modal with no URL, the way Notion's settings work — costs
 * more than it looks. You cannot send someone a link to a settings page, the
 * back button does nothing, and support cannot say "open this". A path under
 * `OVERLAY_PREFIXES` gets both: it floats over the last page of the shell the
 * user was on, which `App` remembers, or over the dashboard when there is none
 * (a pasted link, a reload). Opening one is a plain navigation to its path.
 */
import { createContext, useContext, useState } from "react";
import { matchPath, useLocation, type Location } from "react-router-dom";
import { isOverlayPath, ROUTE_ACCESS } from "./route-access";

const DASHBOARD: Location = { pathname: "/", search: "", hash: "", state: null, key: "default" };

const PAGE_PATHS = Object.keys(ROUTE_ACCESS).filter((path) => !isOverlayPath(path));

/**
 * A screen of the shell, which an overlay may float over. Sign-in, onboarding
 * and the auth callback are hand-offs: rendered again underneath, their
 * redirects would fire a second time and close the overlay.
 */
export function isPage(pathname: string): boolean {
  return PAGE_PATHS.some((path) => matchPath(path, pathname) !== null);
}

/**
 * The location the page tree renders: the current one, or under an overlay the
 * last page shown (`lastPage`), the dashboard when there is none.
 */
export function pageLocation(current: Location, lastPage: Location | null): Location {
  if (!isOverlayPath(current.pathname)) return current;
  return lastPage ?? DASHBOARD;
}

/** `pageLocation` for the router's current location, remembering the last page across renders. */
export function usePageLocation(): Location {
  const location = useLocation();
  const [lastPage, setLastPage] = useState<Location | null>(null);
  if (location !== lastPage && isPage(location.pathname)) setLastPage(location);
  return pageLocation(location, lastPage);
}

interface OpenOverlay {
  /** The overlay's own path, as the address bar shows it. */
  path: string;
  /** The page it floats over. */
  background: Location;
}

const OverlayContext = createContext<OpenOverlay | null>(null);
export const OverlayProvider = OverlayContext.Provider;

/** The screen the open overlay floats over, or null when none is open. */
export function useBackgroundLocation(): Location | null {
  return useContext(OverlayContext)?.background ?? null;
}

/**
 * The open overlay's path, or null. Under an overlay the page tree's
 * `useLocation` answers the page beneath it, so the shell asks here whether
 * settings or the catalogue is open.
 */
export function useOverlayPath(): string | null {
  return useContext(OverlayContext)?.path ?? null;
}

/** Complete router target for closing a modal without losing filters or anchors. */
export function modalReturnTarget(background: Location | null): {
  to: { pathname: string; search: string; hash: string };
  state: unknown;
} {
  const { pathname, search, hash, state } = background ?? DASHBOARD;
  return { to: { pathname, search, hash }, state };
}
