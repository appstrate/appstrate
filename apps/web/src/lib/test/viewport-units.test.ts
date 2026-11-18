// SPDX-License-Identifier: Apache-2.0

/**
 * A screen's height is `dvh`, never `vh` or `screen`. `vh` is the viewport with the browser bars
 * retracted, so on a phone a `100vh` box is taller than what is visible and its bottom (a
 * composer, a button) sits under the browser's toolbar; `dvh` follows the bars. The shell sizes
 * its heights from the same unit, and `interactive-widget=resizes-content` in `index.html` makes
 * `dvh` follow the on-screen keyboard on Chrome and Firefox for Android.
 */

import { describe, it, expect } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "..", "..");
const REPO = join(WEB, "..", "..");

const ROOTS = [
  join(WEB, "src"),
  join(REPO, "packages", "module-chat", "src"),
  join(REPO, "packages", "ui", "src"),
];

// `100vh`, a `vh` length in a calc, `h-screen`, `min-h-screen`, `max-h-screen`.
const BANNED = /(\d(?:\.\d+)?vh\b|(?<![\w-])(?:min-|max-)?h-screen\b)/;

function sources(): string[] {
  const glob = new Glob("**/*.{ts,tsx,css}");
  return ROOTS.flatMap((root) =>
    [...glob.scanSync({ cwd: root, absolute: true })].filter(
      (file) => !/[\\/]test[\\/]|\.test\.tsx?$/.test(file),
    ),
  );
}

describe("viewport units", () => {
  it("scans the three source trees", () => {
    expect(sources().length).toBeGreaterThan(100);
  });

  it("no source sizes a screen in vh or h-screen", () => {
    const offenders = sources().flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          BANNED.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
        ),
    );
    expect(offenders).toEqual([]);
  });

  it("the viewport meta lets the keyboard resize the layout and never blocks zoom", () => {
    const html = readFileSync(join(WEB, "index.html"), "utf8");
    const meta = html.match(/<meta\s+name="viewport"[^>]*>/)?.[0] ?? "";
    expect(meta).toContain("interactive-widget=resizes-content");
    expect(meta).not.toContain("maximum-scale");
    expect(meta).not.toContain("user-scalable");
  });
});
