// SPDX-License-Identifier: Apache-2.0

export const CHROME_HEIGHT = 44;
const BROWSER_PANEL_RATIO = 0.48;
const PANEL_SEPARATOR_WIDTH = 1;

export type ViewMode = "webapp" | "split" | "browser";

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
  const contentHeight = Math.max(0, height - CHROME_HEIGHT);
  const fullContent = { x: 0, y: CHROME_HEIGHT, width, height: contentHeight };

  if (mode !== "split") {
    return {
      chrome: { x: 0, y: 0, width, height: CHROME_HEIGHT },
      webapp: fullContent,
      browser: fullContent,
    };
  }

  const browserWidth = Math.round(width * BROWSER_PANEL_RATIO);
  const webappWidth = width - browserWidth;
  return {
    chrome: { x: 0, y: 0, width, height: CHROME_HEIGHT },
    webapp: { x: 0, y: CHROME_HEIGHT, width: webappWidth, height: contentHeight },
    browser: {
      x: webappWidth + PANEL_SEPARATOR_WIDTH,
      y: CHROME_HEIGHT,
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
