// SPDX-License-Identifier: Apache-2.0

/**
 * Routed modals: surfaces that overlay the current screen but keep a real URL.
 *
 * The alternative — a modal with no URL, the way Notion's settings work — costs
 * more than it looks. You cannot send someone a link to a settings page, the
 * back button does nothing, and support cannot say "open this". Attaching the
 * previous location to the navigation state gets both: opened from inside the
 * app the surface floats over what you were doing, opened from a cold link or a
 * reload it renders as a full page.
 */
import type { Location } from "react-router-dom";
import { useLocation } from "react-router-dom";

interface ModalState {
  backgroundLocation?: Location;
}

/** The screen a modal is floating over, or null when there is none. */
export function useBackgroundLocation(): Location | null {
  const location = useLocation();
  return (location.state as ModalState | null)?.backgroundLocation ?? null;
}

/** True when the current route is being presented as an overlay. */
export function useIsModalRoute(): boolean {
  return useBackgroundLocation() !== null;
}

/**
 * Navigation state that turns a `<Link>` into a modal opener. Pass the location
 * the user is currently on:
 *
 *     <Link to="/org-settings" state={openAsModal(location)}>
 */
export function openAsModal(current: Location): ModalState {
  return { backgroundLocation: current };
}

/** Complete router target for closing a modal without losing filters or anchors. */
export function modalReturnTarget(background: Location | null): {
  to: { pathname: string; search: string; hash: string };
  state: unknown;
} {
  return background
    ? {
        to: {
          pathname: background.pathname,
          search: background.search,
          hash: background.hash,
        },
        state: background.state,
      }
    : { to: { pathname: "/", search: "", hash: "" }, state: null };
}
