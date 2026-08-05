// SPDX-License-Identifier: Apache-2.0

/**
 * Security guard for the package file explorer: package bytes are SOURCE ONLY.
 *
 * A `.afps` artifact is author-controlled content that the explorer fetches
 * into the platform origin. HTML, SVG, Markdown and JSON in it must reach the
 * screen as editor text and nothing else — one `dangerouslySetInnerHTML` or one
 * `<iframe srcDoc={…}>` added later turns the explorer into stored XSS against
 * every member of the org that installed the package.
 *
 * This is a STATIC SOURCE SCAN rather than a render assertion, for the same
 * reason `locales/test/locale-keys.test.ts` scans the SPA source: a render test
 * only covers the branch it renders, whereas the scan keeps holding for every
 * future edit to the directory — including files that do not exist yet.
 *
 * `URL.createObjectURL` is DELIBERATELY ALLOWED: the download path builds an
 * object URL, hands it to an invisible `<a download>` and revokes it. That
 * never renders the bytes — the browser writes them to disk. Do not "fix" a
 * failure here by banning it.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const COMPONENTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPLORER_DIR = join(COMPONENTS_DIR, "package-files");

/**
 * Every way author-controlled bytes could be INTERPRETED rather than displayed.
 * `<img src={…}>` is included because an expression-bound source is how package
 * bytes would reach an image sink (a static `src="/logo.svg"` is app-owned and
 * fine); `[^>]*` cannot cross the tag boundary but does cross newlines, so a
 * prettier-wrapped attribute list is still matched.
 */
const SINKS = [
  { name: "dangerouslySetInnerHTML", pattern: /dangerouslySetInnerHTML/ },
  { name: "<iframe>", pattern: /<iframe\b/i },
  { name: "srcDoc", pattern: /\bsrc[Dd]oc\b/ },
  { name: "<img src={…}>", pattern: /<img\b[^>]*\bsrc\s*=\s*\{/ },
] as const;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (/\.tsx?$/.test(path)) acc.push(path);
  }
  return acc;
}

const FILES = sourceFiles(EXPLORER_DIR);

describe("package file explorer rendering sinks", () => {
  it("scans every source file of the explorer", () => {
    // Guards against the whole suite quietly becoming a no-op if the directory
    // is renamed or emptied — an empty scan passes every assertion below.
    expect(FILES.length).toBeGreaterThan(0);
    expect(FILES.map((f) => relative(EXPLORER_DIR, f)).sort()).toEqual([
      "file-explorer.tsx",
      "file-preview.tsx",
      "read-only-file-tree.tsx",
      "use-package-file.ts",
    ]);
  });

  it("renders package bytes through no sink that could interpret them", () => {
    const offenders: string[] = [];
    for (const path of FILES) {
      const source = readFileSync(path, "utf8");
      for (const sink of SINKS) {
        if (sink.pattern.test(source)) {
          offenders.push(`${relative(COMPONENTS_DIR, path)} → ${sink.name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the object-URL download path allowed", () => {
    // The positive half of the rule: the explorer DOES build an object URL, and
    // none of the patterns above may be widened to catch it.
    const blob = FILES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(blob).toContain("URL.createObjectURL");
    for (const sink of SINKS) expect(sink.pattern.test("URL.createObjectURL(data)")).toBe(false);
  });

  it("actually detects each sink it claims to detect", () => {
    // Control positive: without this, a typo'd pattern makes the guard
    // decorative and every scan above passes vacuously.
    const samples: Record<(typeof SINKS)[number]["name"], string> = {
      dangerouslySetInnerHTML: `<div dangerouslySetInnerHTML={{ __html: text }} />`,
      "<iframe>": `<iframe sandbox="" src={url} />`,
      srcDoc: `<iframe\n  srcDoc={text}\n/>`,
      "<img src={…}>": `<img\n  alt=""\n  src={objectUrl}\n/>`,
    };
    for (const sink of SINKS) {
      expect(sink.pattern.test(samples[sink.name])).toBe(true);
    }
    // And each leaves an innocuous neighbour alone.
    expect(SINKS.find((s) => s.name === "<img src={…}>")!.pattern.test(`<img src="/logo.svg" />`)) //
      .toBe(false);
  });
});
