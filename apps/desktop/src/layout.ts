// SPDX-License-Identifier: Apache-2.0

export const CHROME_HEIGHT = 44;
/** Tab strip row, shown only while the browser panel is open. */
export const TAB_STRIP_HEIGHT = 32;
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
export function chromeHeight(mode: ViewMode): number {
  return mode === "webapp" ? CHROME_HEIGHT : CHROME_HEIGHT + TAB_STRIP_HEIGHT;
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
): DesktopLayout {
  const top = chromeHeight(mode);
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

export function togglePanel(mode: ViewMode): ViewMode {
  return mode === "webapp" ? "split" : "webapp";
}

export function toggleBrowserFocus(mode: ViewMode): ViewMode {
  return mode === "browser" ? "split" : "browser";
}
