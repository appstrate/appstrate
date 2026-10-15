// SPDX-License-Identifier: Apache-2.0

// Routed modals: overlays with a real URL. A path under `OVERLAY_PREFIXES` floats over
// the page it was opened from (kept in history state), or the dashboard when none.
import { createContext, useContext, useEffect, useState } from "react";
import { matchPath, useLocation, useNavigate, type Location } from "react-router-dom";
import { isOverlayPath, isUnder, ROUTE_ACCESS } from "./route-access";

const DASHBOARD: Location = { pathname: "/", search: "", hash: "", state: null, key: "default" };

const PAGE_PATHS = Object.keys(ROUTE_ACCESS).filter((path) => !isOverlayPath(path));

/** A screen an overlay may float over. Sign-in, onboarding and the auth callback are excluded: rendered underneath, their redirects would fire again and close the overlay. */
export function isPage(pathname: string): boolean {
  return PAGE_PATHS.some((path) => matchPath(path, pathname) !== null);
}

export function pageLocation(current: Location, background: Location | null): Location {
  if (!isOverlayPath(current.pathname)) return current;
  return background ?? DASHBOARD;
}

/**
 * An entry's position in the session history. Reads React Router 7's undocumented
 * `idx`; `lib/test/modal-route.test.ts` fails the day it moves.
 */
export function historyIndexOf(state: unknown): number | null {
  const index =
    typeof state === "object" && state !== null ? (state as { idx?: unknown }).idx : undefined;
  return typeof index === "number" ? index : null;
}

function historyIndex(): number | null {
  return typeof window === "undefined" ? null : historyIndexOf(window.history.state);
}

export interface OverlayBackground {
  location: Location;
  /** `null` when it has no entry behind the overlay (a pasted link, an organization switch). */
  index: number | null;
}

/** History state key holding the background, so a reload still floats over the page it was opened from. */
const BACKGROUND = "overlayBackground";

export function backgroundOf(state: unknown): OverlayBackground | null {
  if (typeof state !== "object" || state === null) return null;
  const background = (state as Record<string, unknown>)[BACKGROUND];
  if (typeof background !== "object" || background === null) return null;
  const { location, index } = background as Partial<OverlayBackground>;
  if (typeof location?.pathname !== "string") return null;
  return { location, index: typeof index === "number" ? index : null };
}

export function withBackground(state: unknown, background: OverlayBackground): unknown {
  const rest = typeof state === "object" && state !== null ? state : {};
  const { pathname, search, hash, state: pageState, key } = background.location;
  return {
    ...rest,
    [BACKGROUND]: {
      location: { pathname, search, hash, state: pageState, key },
      index: background.index,
    },
  };
}

function sameBackground(a: OverlayBackground, b: OverlayBackground): boolean {
  return (
    a.index === b.index &&
    a.location.key === b.location.key &&
    a.location.pathname === b.location.pathname &&
    a.location.search === b.location.search &&
    a.location.hash === b.location.hash
  );
}

interface OpenOverlay {
  path: string;
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
 * The page the page tree renders, and the overlay open over it. An overlay entry
 * without a background in its state (a plain `<Link>`, a page opened inside the
 * overlay) takes the last background seen.
 */
export function useOverlayState(): {
  page: Location;
  overlay: OpenOverlay | null;
  exit: OverlayExit | null;
} {
  const location = useLocation();
  const navigate = useNavigate();
  const [last, setLast] = useState<{ at: Location; background: OverlayBackground } | null>(null);
  const onOverlay = isOverlayPath(location.pathname);
  const held = onOverlay ? backgroundOf(location.state) : null;
  if (location !== last?.at) {
    const seen = isPage(location.pathname) ? { location, index: historyIndex() } : held;
    // The page keeps the object it rendered with: a copy read back from state would re-render it.
    if (seen && !(last && sameBackground(seen, last.background))) {
      setLast({ at: location, background: seen });
    }
  }
  const background =
    held && last && sameBackground(held, last.background)
      ? last.background
      : (held ?? (onOverlay ? (last?.background ?? null) : null));
  const page = pageLocation(location, background?.location ?? null);

  const missing = onOverlay && held === null ? (last?.background ?? null) : null;
  useEffect(() => {
    if (!missing) return;
    const { pathname, search, hash, state } = location;
    navigate({ pathname, search, hash }, { replace: true, state: withBackground(state, missing) });
  }, [location, missing, navigate]);

  if (page === location) return { page, overlay: null, exit: null };
  return {
    page,
    overlay: { path: location.pathname, background: page },
    exit: {
      backgroundIndex: background?.index ?? null,
      replaceBackground: (pathname) => {
        const { search, hash, state } = location;
        navigate(
          { pathname: location.pathname, search, hash },
          {
            replace: true,
            state: withBackground(state, { location: { ...DASHBOARD, pathname }, index: null }),
          },
        );
      },
    },
  };
}

function useBackgroundLocation(): Location | null {
  return useContext(OverlayContext)?.background ?? null;
}

/** The open overlay's path, or null (under an overlay `useLocation` answers the page beneath). */
export function useOverlayPath(): string | null {
  return useContext(OverlayContext)?.path ?? null;
}

export function modalReturnTarget(background: Location | null): {
  to: { pathname: string; search: string; hash: string };
  state: unknown;
} {
  const { pathname, search, hash, state } = background ?? DASHBOARD;
  return { to: { pathname, search, hash }, state };
}

/** How far back closing goes (past every page opened inside the overlay); `null` = no entry behind, replace instead. */
export function overlayCloseStep(
  backgroundIndex: number | null,
  currentIndex: number | null,
): number | null {
  if (backgroundIndex === null || currentIndex === null || currentIndex <= backgroundIndex) {
    return null;
  }
  return backgroundIndex - currentIndex;
}

/** Closes the open overlay by stepping back over its entries, so Back after a close does not reopen it. */
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

export function orgSwitchLanding(pagePath: string): "/" | "/chat" {
  return isUnder(pagePath, "/chat") ? "/chat" : "/";
}

/**
 * After an organization switch the page may name a resource of the previous org:
 * it lands on its product's root. Under an overlay only the page beneath moves
 * (overlay paths name a page type, not a resource).
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
