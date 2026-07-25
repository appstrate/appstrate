// SPDX-License-Identifier: Apache-2.0

export const CHROME_HEIGHT = 44;
/** Tab strip row, shown only while the browser panel is open. */
export const TAB_STRIP_HEIGHT = 32;
/** Hand-back banner: what the agent is asking the person to do. */
export const BANNER_HEIGHT = 40;
/**
 * Border left visible around an agent-driven tab. Painted by the window
 * behind an inset view, never injected into the page: a site cannot see
 * it, and no page CSS can break it.
 */
export const AGENT_FRAME_WIDTH = 3;
const BROWSER_PANEL_RATIO = 0.48;
const PANEL_SEPARATOR_WIDTH = 1;

export type ViewMode = "webapp" | "split" | "browser";

/**
 * Chrome is one row when only the webapp shows, two once tabs are on
 * screen. The strip spans the window rather than just the browser
 * column: the chrome is a single WebContentsView painted above both
 * panes, so a partial-width row would have to punch a transparent hole
 * through it.
 */
export function chromeHeight(mode: ViewMode, banner = false): number {
  if (mode === "webapp") return CHROME_HEIGHT;
  return CHROME_HEIGHT + TAB_STRIP_HEIGHT + (banner ? BANNER_HEIGHT : 0);
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopLayout {
  chrome: ViewBounds;
  webapp: ViewBounds;
  browser: ViewBounds;
}

export function calculateDesktopLayout(
  width: number,
  height: number,
  mode: ViewMode,
  opts: { banner?: boolean } = {},
): DesktopLayout {
  const top = chromeHeight(mode, opts.banner);
  const contentHeight = Math.max(0, height - top);
  const fullContent = { x: 0, y: top, width, height: contentHeight };

  if (mode !== "split") {
    return {
      chrome: { x: 0, y: 0, width, height: top },
      webapp: fullContent,
      browser: fullContent,
    };
  }

  const browserWidth = Math.round(width * BROWSER_PANEL_RATIO);
  const webappWidth = width - browserWidth;
  return {
    chrome: { x: 0, y: 0, width, height: top },
    webapp: { x: 0, y: top, width: webappWidth, height: contentHeight },
    browser: {
      x: webappWidth + PANEL_SEPARATOR_WIDTH,
      y: top,
      width: browserWidth - PANEL_SEPARATOR_WIDTH,
      height: contentHeight,
    },
  };
}

/**
 * Inset the browser surface so the window's background shows through as
 * a frame. Neutral (no inset) for a tab the person owns: the marker
 * means "something else is driving this", so it must not become
 * wallpaper.
 */
export function insetForAgent(bounds: ViewBounds, framed: boolean): ViewBounds {
  if (!framed) return bounds;
  const w = AGENT_FRAME_WIDTH;
  return {
    x: bounds.x + w,
    y: bounds.y + w,
    width: Math.max(0, bounds.width - w * 2),
    height: Math.max(0, bounds.height - w * 2),
  };
}

export function togglePanel(mode: ViewMode): ViewMode {
  return mode === "webapp" ? "split" : "webapp";
}

export function toggleBrowserFocus(mode: ViewMode): ViewMode {
  return mode === "browser" ? "split" : "browser";
}
