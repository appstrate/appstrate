// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { calculateDesktopLayout, toggleBrowserFocus, togglePanel } from "../src/layout.ts";

describe("desktop layout", () => {
  it("keeps both surfaces full-sized when the browser panel is closed", () => {
    const layout = calculateDesktopLayout(1200, 800, "webapp");

    expect(layout.chrome).toEqual({ x: 0, y: 0, width: 1200, height: 44 });
    expect(layout.webapp).toEqual({ x: 0, y: 44, width: 1200, height: 756 });
    expect(layout.browser).toEqual(layout.webapp);
  });

  it("places the browser on the right in split mode", () => {
    const layout = calculateDesktopLayout(1200, 800, "split");

    expect(layout.webapp).toEqual({ x: 0, y: 44, width: 624, height: 756 });
    expect(layout.browser).toEqual({ x: 625, y: 44, width: 575, height: 756 });
    expect(layout.browser.x - layout.webapp.width).toBe(1);
  });

  it("keeps both surfaces full-sized when the browser is focused", () => {
    const layout = calculateDesktopLayout(1200, 800, "browser");

    expect(layout.browser).toEqual({ x: 0, y: 44, width: 1200, height: 756 });
    expect(layout.webapp).toEqual(layout.browser);
  });

  it("opens and closes the panel without conflating browser focus", () => {
    expect(togglePanel("webapp")).toBe("split");
    expect(togglePanel("split")).toBe("webapp");
    expect(togglePanel("browser")).toBe("webapp");
    expect(toggleBrowserFocus("split")).toBe("browser");
    expect(toggleBrowserFocus("browser")).toBe("split");
  });
});
