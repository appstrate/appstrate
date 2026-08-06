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
  // Navigating to a blob URL renders it in this origin exactly as opening a
  // window would. `window.open` alone left three equivalent doors open.
  { name: "window.open()", pattern: /\bwindow\s*\.\s*open\s*\(/ },
  { name: "location.href =", pattern: /\blocation\s*\.\s*href\s*=(?!=)/ },
  { name: "location.assign()", pattern: /\blocation\s*\.\s*assign\s*\(/ },
  { name: "location.replace()", pattern: /\blocation\s*\.\s*replace\s*\(/ },
] as const;

/**
 * Forbidden in the EXPLORER only. The manifest view legitimately renders one
 * `<a href={entry.href}>`, and its own rule below pins that the href can only
 * be a value `normalizeHttpUrl` accepted — so the sink is checked there, not
 * banned. Nothing in the explorer has any business turning package bytes into
 * a link, and until now an `href={…}` in `components/package-files/` was
 * checked by neither scope.
 */
const EXPLORER_ONLY_SINKS = [
  { name: "<a href={…}>", pattern: /<a\b[^>]*\bhref\s*=\s*\{/ },
] as const;

const EXPLORER_SINKS = [...SINKS, ...EXPLORER_ONLY_SINKS];

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
  // A single numeric constant, no imports of its own — the shared ceiling the
  // server inlines up to and the preview refuses above. Not a renderer.
  "@appstrate/core/package-files",
  "@appstrate/core/validation",
  "@appstrate/ui/cn",
  "@appstrate/ui/components/button",
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
 * The text between a call's `(` and the paren that CLOSES it, or `null` when
 * the source never closes it.
 */
function callArgument(source: string, afterOpenParen: number): string | null {
  let depth = 1;
  for (let i = afterOpenParen; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return source.slice(afterOpenParen, i);
  }
  return null;
}

/**
 * Every way a `URL.createObjectURL` call in this source is unsafe: it must
 * wrap a blob THIS code built (not bytes handed to it) and pin that blob to an
 * inert type. Shared by the rule and its control positive, so the control
 * exercises the rule rather than a copy of its string literals.
 *
 * Scoped to the call's OWN argument list — the first token after `(`, and the
 * inert type anywhere before the paren closing it at depth 1. A fixed-width
 * window let an adjacent statement supply both tokens, so
 *
 *     URL.createObjectURL(new Blob([text], { type: "text/html" }));
 *     const dl = new Blob([bytes], { type: "application/octet-stream" });
 *
 * scanned clean — a verified bypass of this exact rule.
 */
function objectUrlFaults(source: string): string[] {
  const faults: string[] = [];
  for (const match of source.matchAll(/URL\.createObjectURL\(/g)) {
    const arg = callArgument(source, match.index + match[0].length);
    if (arg === null) {
      faults.push("createObjectURL with an unterminated argument list");
    } else if (!/^\s*new Blob\(/.test(arg)) {
      faults.push("createObjectURL on a blob it did not build");
    } else if (!arg.includes('type: "application/octet-stream"')) {
      faults.push("createObjectURL without an inert MIME type");
    }
  }
  return faults;
}

/** `from "x"`, bare `import "x"`, and `import("x")`. */
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/**
 * Shown IN the failure, not above it, because the developer who trips this rule
 * is reading a diff and not this file. The comment-blindness is the part that
 * looks like a bug and is not, so the message has to carry the reason with it.
 */
const UNLISTED_IMPORT_GUIDANCE = [
  "An unlisted specifier reached a scanned file. Two very different causes:",
  "",
  "  1. A REAL import. This is the decision point the allowlist exists for —",
  "     add it deliberately (does it drag in an HTML sink?), or drop the import.",
  "     Never widen the list just to make this green.",
  "",
  "  2. PROSE IN A COMMENT. This scanner reads raw file text and is deliberately",
  '     comment-blind: stripping comments first would break on `from "https://…"`,',
  "     where the `//` inside the URL eats the rest of the line — turning a REAL",
  "     import into a false NEGATIVE. False positives on prose are the price, and",
  "     they are the safe direction. Reword the comment; do not list the phrase.",
  "",
  "A specifier containing a space is always cause 2.",
].join("\n");

/** Relative specifiers become `dir/file`, so the entry is depth-independent. */
function normalizeSpecifier(fromFile: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const resolved = relative(WEB_SRC, resolve(dirname(fromFile), specifier));
  return resolved.replace(/\.(tsx?|jsx?)$/, "");
}

/**
 * Both ways one surface's allowlist can be wrong: something it imports is not
 * on the list, and something on the list is imported by nothing.
 *
 * Parametrized over `(sources, allowed)` the way `objectUrlFaults` is over one
 * source — the SCAN is shared machinery, the SET and the LIST are not. Each
 * surface passes its own pair at its own call site, so merging the two
 * allowlists still takes an edit that is visible as one. Offender strings stay
 * `label → specifier`, and `label` is the path relative to `src/`, so a failure
 * names the file and the module exactly as before.
 */
function importFaults(
  sources: readonly { label: string; source: string }[],
  allowed: readonly string[],
): { offenders: string[]; unused: string[] } {
  const found = new Set<string>();
  const offenders: string[] = [];
  for (const { label, source } of sources) {
    const file = join(WEB_SRC, label);
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = normalizeSpecifier(file, match[1]!);
      found.add(specifier);
      if (!allowed.includes(specifier)) offenders.push(`${label} → ${specifier}`);
    }
  }
  return { offenders, unused: allowed.filter((entry) => !found.has(entry)) };
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
      for (const sink of EXPLORER_SINKS) {
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
    const { offenders, unused } = importFaults(SOURCES, ALLOWED_IMPORTS);

    expect(offenders, UNLISTED_IMPORT_GUIDANCE).toEqual([]);
    // And the allowlist itself stays honest: an entry nobody imports any more
    // is a hole left open for the next person to walk through.
    expect(unused).toEqual([]);
  });

  it("actually detects each sink it claims to detect", () => {
    // Control positive: without this, a typo'd pattern makes the guard
    // decorative and every scan above passes vacuously.
    const samples: Record<(typeof EXPLORER_SINKS)[number]["name"], string> = {
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
      "location.href =": `window.location.href = previewUrl;`,
      "location.assign()": `location.assign(previewUrl);`,
      "location.replace()": `window.location.replace(previewUrl);`,
      "<a href={…}>": `<a\n  target="_blank"\n  href={objectUrl}\n>open</a>`,
    };
    for (const sink of EXPLORER_SINKS) {
      expect(sink.pattern.test(samples[sink.name])).toBe(true);
    }
    // And each leaves its innocuous neighbour alone.
    const byName = (name: (typeof EXPLORER_SINKS)[number]["name"]) =>
      EXPLORER_SINKS.find((s) => s.name === name)!;
    expect(byName("<img src={…}>").pattern.test(`<img src="/logo.svg" />`)).toBe(false);
    expect(byName(".innerHTML =").pattern.test(`const html = el.innerHTML;`)).toBe(false);
    expect(byName("eval()").pattern.test(`const evaluated = score;`)).toBe(false);
    // The download path assigns `a.href`, which is not a navigation.
    expect(byName("location.href =").pattern.test(`a.href = url;`)).toBe(false);
    expect(byName("location.href =").pattern.test(`if (location.href === url) return;`)).toBe(
      false,
    );
    expect(byName("<a href={…}>").pattern.test(`<a href="/docs">docs</a>`)).toBe(false);
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

  it("does not let a neighbouring statement launder the object URL", () => {
    // The bypass a fixed-width window allowed: the preview blob is `text/html`
    // and the inert literal comes from the NEXT line, which is a perfectly
    // ordinary download call. Both tokens the old rule looked for were present
    // within 200 characters, so it scanned clean.
    const bypass = [
      `const previewUrl = URL.createObjectURL(new Blob([text], { type: "text/html" }));`,
      `const dl = new Blob([bytes], { type: "application/octet-stream" });`,
      `window.location.href = previewUrl;`,
    ].join("\n");

    expect(objectUrlFaults(bypass)).toEqual(["createObjectURL without an inert MIME type"]);
    // …and the navigation that consumes it is a sink in its own right, so the
    // two rules catch this independently.
    expect(EXPLORER_SINKS.some((sink) => sink.pattern.test(bypass))).toBe(true);
  });

  it("reports a call whose argument list is never closed", () => {
    // Paren matching has to fail LOUD: silently treating an unterminated call
    // as compliant would make truncated or minified input a free pass.
    expect(
      objectUrlFaults(`URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }`),
    ).toEqual(["createObjectURL with an unterminated argument list"]);
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
  // Manifest READERS, not renderers: `normalizeHttpUrl` is the href protocol
  // allowlist and `getMcpServerRuntime` is the `_meta` runtime override the
  // platform itself resolves with. Neither turns a manifest string into markup.
  "@appstrate/core/mcp-server-meta",
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
    // Its OWN allowlist, scanned by the shared helper — merging the two lists
    // would silently let each directory import whatever the other needs.
    const { offenders, unused } = importFaults(MANIFEST_SOURCES, MANIFEST_ALLOWED_IMPORTS);

    expect(offenders, UNLISTED_IMPORT_GUIDANCE).toEqual([]);
    expect(unused).toEqual([]);
  });
});
