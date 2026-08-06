// SPDX-License-Identifier: Apache-2.0

/**
 * Security guard for the two surfaces that render package content: package
 * bytes and the manifest are SOURCE ONLY.
 *
 * A `.afps` artifact is author-controlled content that the explorer fetches
 * into the platform origin. HTML, SVG, Markdown and JSON in it must reach the
 * screen as editor text and nothing else — one `dangerouslySetInnerHTML`, one
 * `<iframe srcDoc={…}>`, or one `blob:` URL opened under an interpretable MIME
 * type turns the explorer into stored XSS against every member of the org that
 * installed the package.
 *
 * The MANIFEST is in the same trust class, and `components/package-manifest`
 * renders it as structure rather than as text — labels, badges, and (the part
 * that matters) `href`s built from author-controlled strings. So it gets the
 * same scan, in its own scope below, with its own allowlist: merging the two
 * would silently let each directory import whatever the other needs.
 *
 * This is a STATIC SOURCE SCAN rather than a render assertion, for the same
 * reason `locales/test/locale-keys.test.ts` scans the SPA source: a render test
 * only covers the branch it renders, whereas the scan keeps holding for every
 * future edit — including files that do not exist yet.
 *
 * Three rules, because a directory-scoped pattern scan alone is bypassable:
 *   1. no rendering sink in the explorer's own source;
 *   2. every `URL.createObjectURL` is pinned to an INERT MIME type — a blob URL
 *      inherits the platform origin, so the type it carries decides whether the
 *      browser would ever interpret the bytes;
 *   3. a closed IMPORT ALLOWLIST — a sink reached through a dependency
 *      (`<Markdown source={text}/>` putting the `dangerouslySetInnerHTML` in
 *      `packages/ui`) is invisible to rules 1 and 2. Pulling in a new module
 *      fails here and forces the decision to be made explicitly.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const COMPONENTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_SRC = dirname(COMPONENTS_DIR);
const EXPLORER_DIR = join(COMPONENTS_DIR, "package-files");
const MANIFEST_DIR = join(COMPONENTS_DIR, "package-manifest");

/**
 * Every way author-controlled bytes could be INTERPRETED rather than displayed.
 * `<img src={…}>` / `<object data={…}>` / `<embed src={…}>` are matched only in
 * their expression-bound form — a static `src="/logo.svg"` is app-owned and
 * fine. `[^>]*` cannot cross the tag boundary but does cross newlines, so a
 * prettier-wrapped attribute list is still caught.
 */
const SINKS = [
  { name: "dangerouslySetInnerHTML", pattern: /dangerouslySetInnerHTML/ },
  { name: "<iframe>", pattern: /<iframe\b/i },
  { name: "srcDoc", pattern: /\bsrc[Dd]oc\b/ },
  { name: "<img src={…}>", pattern: /<img\b[^>]*\bsrc\s*=\s*\{/ },
  { name: "<object data={…}>", pattern: /<object\b[^>]*\bdata\s*=\s*\{/i },
  { name: "<embed src={…}>", pattern: /<embed\b[^>]*\bsrc\s*=\s*\{/i },
  { name: ".innerHTML =", pattern: /\.(inner|outer)HTML\s*=/ },
  { name: "insertAdjacentHTML", pattern: /\binsertAdjacentHTML\b/ },
  { name: "document.write", pattern: /\bdocument\s*\.\s*write\b/ },
  { name: "eval()", pattern: /\beval\s*\(/ },
  { name: "new Function()", pattern: /\bnew\s+Function\s*\(/ },
  { name: "window.open()", pattern: /\bwindow\s*\.\s*open\s*\(/ },
] as const;

/**
 * Every module the explorer is allowed to reach, relative specifiers resolved
 * so an entry does not depend on which file imported it. This is the closed
 * set: adding a renderer, a markdown component or an HTML sanitizer here is a
 * deliberate, reviewable act.
 *
 * `components/monaco` is the ONLY renderer, and it renders text into a
 * read-only editor.
 */
const ALLOWED_IMPORTS = [
  // Framework + libraries
  "@appstrate/core/format",
  "@appstrate/core/validation",
  "@appstrate/ui/cn",
  "@appstrate/ui/components/button",
  "@tanstack/react-query",
  "@tanstack/react-virtual",
  "lucide-react",
  "react",
  "react-i18next",
  "sonner",
  // SPA modules
  "api/client",
  "api/schema",
  "components/monaco",
  "components/package-files/file-preview",
  "components/package-files/read-only-file-tree",
  "components/package-files/use-package-file",
  "components/page-states",
  "hooks/use-org-scope",
  "lib/package-file-tree",
  "lib/package-files",
  "lib/package-paths",
  "stores/theme-store",
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (/\.tsx?$/.test(path)) acc.push(path);
  }
  return acc;
}

/**
 * The explorer's own source. `lib/package-file-tree.ts` is part of it despite
 * living outside the component directory — a directory-shaped rule would leave
 * the module every one of these files imports unscanned.
 */
const FILES = [...sourceFiles(EXPLORER_DIR), join(WEB_SRC, "lib/package-file-tree.ts")];

const SOURCES = FILES.map((path) => ({
  label: relative(WEB_SRC, path),
  source: readFileSync(path, "utf8"),
}));

/**
 * Every way a `URL.createObjectURL` call in this source is unsafe: it must
 * wrap a blob THIS code built (not bytes handed to it) and pin that blob to an
 * inert type. Shared by the rule and its control positive, so the control
 * exercises the rule rather than a copy of its string literals.
 */
function objectUrlFaults(source: string): string[] {
  const faults: string[] = [];
  for (const match of source.matchAll(/URL\.createObjectURL\(/g)) {
    const call = source.slice(match.index, match.index + 200);
    if (!call.includes("new Blob(")) {
      faults.push("createObjectURL on a blob it did not build");
    } else if (!call.includes('type: "application/octet-stream"')) {
      faults.push("createObjectURL without an inert MIME type");
    }
  }
  return faults;
}

/** `from "x"`, bare `import "x"`, and `import("x")`. */
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/** Relative specifiers become `dir/file`, so the entry is depth-independent. */
function normalizeSpecifier(fromFile: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const resolved = relative(WEB_SRC, resolve(dirname(fromFile), specifier));
  return resolved.replace(/\.(tsx?|jsx?)$/, "");
}

describe("package file explorer rendering sinks", () => {
  it("scans a non-empty source set", () => {
    // Guards against the whole suite quietly becoming a no-op if the directory
    // is renamed or emptied — an empty scan passes every assertion below.
    expect(SOURCES.length).toBeGreaterThan(1);
    expect(SOURCES.map((s) => s.label)).toContain("lib/package-file-tree.ts");
  });

  it("renders package bytes through no sink that could interpret them", () => {
    const offenders: string[] = [];
    for (const { label, source } of SOURCES) {
      for (const sink of SINKS) {
        if (sink.pattern.test(source)) offenders.push(`${label} → ${sink.name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("pins every object URL to an inert MIME type", () => {
    // `URL.createObjectURL` is legitimate — the download path needs it — but a
    // blob URL inherits the platform origin, so handing it `text/html` and then
    // an `<a href>` or `window.open` is stored XSS with the pattern scan green.
    const offenders = SOURCES.flatMap(({ label, source }) =>
      objectUrlFaults(source).map((fault) => `${label} → ${fault}`),
    );

    expect(offenders).toEqual([]);
    // A rule that scans for a call nobody makes any more is not a rule.
    expect(SOURCES.some(({ source }) => source.includes("URL.createObjectURL("))).toBe(true);
  });

  it("imports only from the closed allowlist", () => {
    // The rule the pattern scan cannot express: a sink reached through an
    // import lives in someone else's file. Widening this list is the decision
    // point — do not do it to silence a failure.
    const found = new Set<string>();
    const offenders: string[] = [];
    for (const { label, source } of SOURCES) {
      const file = join(WEB_SRC, label);
      for (const match of source.matchAll(IMPORT_RE)) {
        const specifier = normalizeSpecifier(file, match[1]!);
        found.add(specifier);
        if (!ALLOWED_IMPORTS.includes(specifier)) offenders.push(`${label} → ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
    // And the allowlist itself stays honest: an entry nobody imports any more
    // is a hole left open for the next person to walk through.
    expect(ALLOWED_IMPORTS.filter((entry) => !found.has(entry))).toEqual([]);
  });

  it("actually detects each sink it claims to detect", () => {
    // Control positive: without this, a typo'd pattern makes the guard
    // decorative and every scan above passes vacuously.
    const samples: Record<(typeof SINKS)[number]["name"], string> = {
      dangerouslySetInnerHTML: `<div dangerouslySetInnerHTML={{ __html: text }} />`,
      "<iframe>": `<iframe sandbox="" src={url} />`,
      srcDoc: `<iframe\n  srcDoc={text}\n/>`,
      "<img src={…}>": `<img\n  alt=""\n  src={objectUrl}\n/>`,
      "<object data={…}>": `<object type="text/html" data={objectUrl} />`,
      "<embed src={…}>": `<embed\n  src={objectUrl}\n/>`,
      ".innerHTML =": `host.innerHTML = text;`,
      insertAdjacentHTML: `host.insertAdjacentHTML("beforeend", text);`,
      "document.write": `document.write(text);`,
      "eval()": `eval(text);`,
      "new Function()": `new Function("t", text);`,
      "window.open()": `window.open(objectUrl, "_blank");`,
    };
    for (const sink of SINKS) {
      expect(sink.pattern.test(samples[sink.name])).toBe(true);
    }
    // And each leaves its innocuous neighbour alone.
    const byName = (name: (typeof SINKS)[number]["name"]) => SINKS.find((s) => s.name === name)!;
    expect(byName("<img src={…}>").pattern.test(`<img src="/logo.svg" />`)).toBe(false);
    expect(byName(".innerHTML =").pattern.test(`const html = el.innerHTML;`)).toBe(false);
    expect(byName("eval()").pattern.test(`const evaluated = score;`)).toBe(false);
  });

  it("actually detects an object URL built under an interpretable type", () => {
    // Control positive for the MIME rule. It exercises `objectUrlFaults` — the
    // same function the rule above runs — because a control positive asserting
    // on its own string literals proves only that `String.includes` works.
    expect(objectUrlFaults(`URL.createObjectURL(new Blob([text], { type: "text/html" }))`)).toEqual(
      ["createObjectURL without an inert MIME type"],
    );
    expect(objectUrlFaults(`URL.createObjectURL(data)`)) //
      .toEqual(["createObjectURL on a blob it did not build"]);
    expect(
      objectUrlFaults(
        `URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }))`,
      ),
    ).toEqual([]);
  });
});

/**
 * Same rules, second surface. `lib/package-manifest.ts` is scanned with the
 * components for the reason `lib/package-file-tree.ts` is scanned with the
 * explorer: it is the module every one of them imports, and it is where the
 * decision "this author string may become an href" is actually made.
 *
 * The object-URL rule is absent by design — the manifest view builds no blobs.
 * That is asserted directly below, which is stronger than pinning a MIME type
 * on a call that does not exist.
 */
const MANIFEST_SOURCES = [
  ...sourceFiles(MANIFEST_DIR),
  join(WEB_SRC, "lib/package-manifest.ts"),
].map((path) => ({ label: relative(WEB_SRC, path), source: readFileSync(path, "utf8") }));

const MANIFEST_ALLOWED_IMPORTS = [
  // Framework + libraries
  "@appstrate/core/url",
  "@appstrate/core/validation",
  "@appstrate/ui/components/badge",
  "lucide-react",
  "react-i18next",
  // SPA modules
  "components/package-manifest/integration-details",
  "components/package-manifest/manifest-fact",
  "components/package-manifest/mcp-server-details",
  "components/page-states",
  "components/section-card",
  "lib/package-manifest",
];

describe("package manifest rendering sinks", () => {
  it("scans a non-empty source set", () => {
    expect(MANIFEST_SOURCES.length).toBeGreaterThan(1);
    expect(MANIFEST_SOURCES.map((s) => s.label)).toContain("lib/package-manifest.ts");
  });

  it("renders manifest strings through no sink that could interpret them", () => {
    const offenders: string[] = [];
    for (const { label, source } of MANIFEST_SOURCES) {
      for (const sink of SINKS) {
        if (sink.pattern.test(source)) offenders.push(`${label} → ${sink.name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("builds no object URL at all", () => {
    const offenders = MANIFEST_SOURCES.filter(({ source }) =>
      source.includes("URL.createObjectURL("),
    ).map(({ label }) => label);

    expect(offenders).toEqual([]);
  });

  it("gives an href only to a protocol-checked URL", () => {
    // The one place a manifest string reaches an `href`. Two rules, both
    // needed: the JSX must not build the href itself, and the reader must
    // reject everything that is not http(s) — `javascript:` and `data:` both
    // parse as perfectly valid URLs, so a `new URL()` that throws is not a
    // safety check.
    // The check itself belongs to `@appstrate/core/url` — the same primitive
    // the integration page uses (#1122) — so what is pinned here is that this
    // module DELEGATES to it, not that it reimplements the allowlist inline.
    // Pinning the inline form would have made moving the check to one shared
    // place look like a regression.
    const readers = MANIFEST_SOURCES.find((s) => s.label === "lib/package-manifest.ts")!.source;
    expect(readers).toContain('import { normalizeHttpUrl } from "@appstrate/core/url"');
    expect(readers).toMatch(/href[\s\S]{0,120}normalizeHttpUrl\(/);

    for (const { label, source } of MANIFEST_SOURCES) {
      if (!source.includes("href=")) continue;
      // Only the field the reader populated may be bound, never a raw manifest
      // value — `href={entry.value}` would render whatever the author wrote.
      expect(`${label}: ${source.match(/href=\{[^}]*\}/g)?.join(" ")}`).toBe(
        `${label}: href={entry.href}`,
      );
      expect(source).toContain('rel="noopener noreferrer"');
    }
  });

  it("imports only from the closed allowlist", () => {
    const found = new Set<string>();
    const offenders: string[] = [];
    for (const { label, source } of MANIFEST_SOURCES) {
      const file = join(WEB_SRC, label);
      for (const match of source.matchAll(IMPORT_RE)) {
        const specifier = normalizeSpecifier(file, match[1]!);
        found.add(specifier);
        if (!MANIFEST_ALLOWED_IMPORTS.includes(specifier))
          offenders.push(`${label} → ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
    expect(MANIFEST_ALLOWED_IMPORTS.filter((entry) => !found.has(entry))).toEqual([]);
  });
});
