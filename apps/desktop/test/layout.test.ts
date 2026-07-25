// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  calculateDesktopLayout,
  insetForAgent,
  toggleBrowserFocus,
  togglePanel,
} from "../src/layout.ts";

describe("desktop layout", () => {
  it("keeps both surfaces full-sized when the browser panel is closed", () => {
    const layout = calculateDesktopLayout(1200, 800, "webapp");

    expect(layout.chrome).toEqual({ x: 0, y: 0, width: 1200, height: 44 });
    expect(layout.webapp).toEqual({ x: 0, y: 44, width: 1200, height: 756 });
    expect(layout.browser).toEqual(layout.webapp);
  });

  it("places the browser on the right in split mode, below the tab strip", () => {
    const layout = calculateDesktopLayout(1200, 800, "split");

    expect(layout.chrome).toEqual({ x: 0, y: 0, width: 1200, height: 76 });
    expect(layout.webapp).toEqual({ x: 0, y: 76, width: 624, height: 724 });
    expect(layout.browser).toEqual({ x: 625, y: 76, width: 575, height: 724 });
    expect(layout.browser.x - layout.webapp.width).toBe(1);
  });

  it("keeps both surfaces full-sized when the browser is focused", () => {
    const layout = calculateDesktopLayout(1200, 800, "browser");

    expect(layout.browser).toEqual({ x: 0, y: 76, width: 1200, height: 724 });
    expect(layout.webapp).toEqual(layout.browser);
  });

  it("hides the tab strip row while only the webapp shows", () => {
    expect(calculateDesktopLayout(1200, 800, "webapp").chrome.height).toBe(44);
    expect(calculateDesktopLayout(1200, 800, "split").chrome.height).toBe(76);
  });

  it("makes room for the hand-back bar in EVERY mode", () => {
    // A waiting agent must stay visible with the browser panel closed,
    // so the bar is not part of the browser chrome.
    expect(calculateDesktopLayout(1200, 800, "webapp", { banner: true }).chrome.height).toBe(84);
    expect(calculateDesktopLayout(1200, 800, "split", { banner: true }).chrome.height).toBe(116);
    expect(calculateDesktopLayout(1200, 800, "browser", { banner: true }).webapp.y).toBe(116);
  });

  it("frames an agent-driven surface without shrinking a user tab", () => {
    const layout = calculateDesktopLayout(1200, 800, "browser");
    expect(insetForAgent(layout.browser, false)).toEqual(layout.browser);
    expect(insetForAgent(layout.browser, true)).toEqual({
      x: 3,
      y: 79,
      width: 1194,
      height: 718,
    });
  });

  it("opens and closes the panel without conflating browser focus", () => {
    expect(togglePanel("webapp")).toBe("split");
    expect(togglePanel("split")).toBe("webapp");
    expect(togglePanel("browser")).toBe("webapp");
    expect(toggleBrowserFocus("split")).toBe("browser");
    expect(toggleBrowserFocus("browser")).toBe("split");
  });
});
