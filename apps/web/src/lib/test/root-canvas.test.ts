// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { THEME_COLORS } from "../../stores/theme-colors.ts";

const html = await Bun.file(new URL("../../../index.html", import.meta.url)).text();
const css = await Bun.file(new URL("../../styles.css", import.meta.url)).text();

/** The declarations of the first rule of `css` whose selector is exactly `selector`. */
function rule(selector: string): string {
  const match = css.match(
    new RegExp(`(?:^|\\n)\\s*${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`),
  );
  return match?.[1] ?? "";
}

describe("the root's canvas", () => {
  it("paints <html> with the page canvas, so a resized viewport never shows white", () => {
    expect(rule("html")).toContain("background-color: var(--canvas)");
  });

  it("tells the browser each theme's colour scheme through the class on <html>", () => {
    expect(rule("html.light")).toContain("color-scheme: light");
    expect(rule("html.dark")).toContain("color-scheme: dark");
  });

  it("declares both schemes before the theme script runs, and a theme colour that follows it", () => {
    expect(html).toMatch(/<meta\s+name="color-scheme"\s+content="light dark"/);
    expect(html).toContain(`name="theme-color" content="${THEME_COLORS.light}"`);
    expect(html).toContain(`.setAttribute("content", "${THEME_COLORS.dark}")`);
  });
});
