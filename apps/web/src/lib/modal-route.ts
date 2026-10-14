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
import { matchPath, useLocation, useNavigate, type Location } from "react-router-dom";
import { isOverlayPath, isUnder, ROUTE_ACCESS } from "./route-access";

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

/**
 * The current entry's position in the session history: React Router's browser
 * history numbers its entries in `history.state.idx`.
 */
function historyIndex(): number | null {
  if (typeof window === "undefined") return null;
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof index === "number" ? index : null;
}

interface OpenOverlay {
  /** The overlay's own path, as the address bar shows it. */
  path: string;
  /** The page it floats over. */
  background: Location;
}

interface OverlayExit {
  /** The background's history entry; `null` when it has none (a pasted link, a reload). */
  backgroundIndex: number | null;
  /** Puts another page under the overlay, one with no history entry. */
  replaceBackground: (pathname: string) => void;
}

const OverlayContext = createContext<OpenOverlay | null>(null);
export const OverlayProvider = OverlayContext.Provider;
const OverlayExitContext = createContext<OverlayExit | null>(null);
export const OverlayExitProvider = OverlayExitContext.Provider;

/**
 * The page the page tree renders, and the overlay open over it, remembering the
 * last page shown across renders.
 */
export function useOverlayState(): {
  page: Location;
  overlay: OpenOverlay | null;
  exit: OverlayExit | null;
} {
  const location = useLocation();
  const [shown, setShown] = useState<{ location: Location; index: number | null } | null>(null);
  if (location !== shown?.location && isPage(location.pathname)) {
    setShown({ location, index: historyIndex() });
  }
  const page = pageLocation(location, shown?.location ?? null);
  if (page === location) return { page, overlay: null, exit: null };
  return {
    page,
    overlay: { path: location.pathname, background: page },
    exit: {
      backgroundIndex: shown?.index ?? null,
      replaceBackground: (pathname) =>
        setShown({ location: { ...DASHBOARD, pathname }, index: null }),
    },
  };
}

/** The screen the open overlay floats over, or null when none is open. */
function useBackgroundLocation(): Location | null {
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

/**
 * How far back closing an overlay goes: to the background's own entry when the
 * app navigated from it, past every page opened inside the overlay. `null`
 * when it has no entry behind the current one: the close replaces instead.
 */
export function overlayCloseStep(
  backgroundIndex: number | null,
  currentIndex: number | null,
): number | null {
  if (backgroundIndex === null || currentIndex === null || currentIndex <= backgroundIndex) {
    return null;
  }
  return backgroundIndex - currentIndex;
}

/**
 * Closes the open overlay. Back steps over the overlay's entries rather than
 * adding one, so Back after a close does not reopen it.
 */
export function useCloseOverlay(): () => void {
  const background = useBackgroundLocation();
  const exit = useContext(OverlayExitContext);
  const navigate = useNavigate();
  return () => {
    const step = overlayCloseStep(exit?.backgroundIndex ?? null, historyIndex());
    if (step !== null) {
      navigate(step);
      return;
    }
    const target = modalReturnTarget(background);
    navigate(target.to, { replace: true, state: target.state });
  };
}

/** The page an organization switch lands on: the root of the product it happened in. */
export function orgSwitchLanding(pagePath: string): "/" | "/chat" {
  return isUnder(pagePath, "/chat") ? "/chat" : "/";
}

/**
 * After an organization switch, the page may name a resource of the previous
 * organization (an agent, a run): it lands on its product's root. Under an
 * overlay only the page beneath moves — the overlay's paths name a page type,
 * not a resource, so it stays open.
 */
export function useLandAfterOrgSwitch(): () => void {
  const background = useBackgroundLocation();
  const exit = useContext(OverlayExitContext);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return () => {
    if (background && exit) exit.replaceBackground(orgSwitchLanding(background.pathname));
    else navigate(orgSwitchLanding(pathname), { replace: true });
  };
}
