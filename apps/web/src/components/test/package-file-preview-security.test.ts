// SPDX-License-Identifier: Apache-2.0

/**
 * Narrow source guards for the two security decisions that cannot be exercised
 * in the DOM-less web test runner: package bytes stay editor source, and the
 * download blob stays inert.
 *
 * Manifest links are covered behaviorally in `manifest-overview.test.tsx` and
 * `lib/test/package-manifest.test.ts`; keeping a closed import graph here made
 * harmless refactors update a second manual allowlist without adding coverage.
 *
 * The download half is asserted in two halves — the readers DELEGATE, and the
 * primitive DECIDES — rather than as one literal expression inside each reader.
 * Pinning the inline form asserts where a check is written instead of that it
 * happens, and reads the move of that check into one shared place as a
 * regression; the manifest sink scan hit exactly that (commit 3a3ffadb7).
 * `lib/test/blob-download.test.ts` covers the primitive behaviorally.
 *
 * "The readers" is plural and EXHAUSTIVE. The primitive has four call sites and
 * scanning one of them proved a quarter of "the delegation cannot be bypassed"
 * while reading as if it proved all of it. `CALLERS` below therefore lists every
 * one — and, unlike the manifest allowlist that was removed from this file, it
 * is checked against the tree rather than maintained by hand: a caller added
 * without a row here fails the completeness test, so the list cannot decay into
 * a stale second copy of the import graph.
 */

import { describe, it, expect } from "bun:test";

const read = async (relative: string) =>
  await Bun.file(decodeURIComponent(new URL(relative, import.meta.url).pathname)).text();

const previewSource = await read("../package-files/file-preview.tsx");
const primitiveSource = await read("../../lib/blob-download.ts");

/**
 * Source without its comments — the guards below are documented in prose that
 * names the very sinks and expressions being counted, and a sink named in a
 * comment is not a sink.
 */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * Source with ALL whitespace stripped, applied to both sides of a comparison so
 * the expected fragment stays readable. A prettier re-wrap must never make a
 * guard that is present read as a guard that is missing.
 */
const dense = (source: string) => source.replace(/\s+/g, "");

const occurrences = (source: string, needle: string) => source.split(needle).length - 1;

const primitiveCode = code(primitiveSource);

/**
 * EVERY caller of the primitive, not just the package-file one.
 *
 * The delegation is only a security property if it holds across the whole
 * surface: scanning one of four readers proved a quarter of "the primitive
 * cannot be bypassed" while reading as if it proved all of it. Adding a fifth
 * download without adding it here leaves it unscanned — which is why the
 * import-site count below is asserted against this list.
 */
const CALLERS = [
  {
    file: "../package-files/use-package-file.ts",
    from: '"../../lib/blob-download"',
    calls: ["triggerBlobDownload(data, baseName(path))"],
  },
  {
    file: "../../hooks/use-packages.ts",
    from: '"../lib/blob-download"',
    calls: [
      "triggerBlobDownload(data, `${stripScope(scope)}-${name}-${version}.afps`)",
      "triggerBlobDownload(data, `${stripScope(scope)}-${name}.afps-bundle`)",
    ],
  },
  {
    file: "../../hooks/use-documents.ts",
    from: '"../lib/blob-download"',
    calls: ["triggerBlobDownload(data, name)"],
    /**
     * `useDocumentImageSrc` builds ONE object URL of its own, for an
     * `<img src>` thumbnail — a preview, not a download, and no `<a download>`
     * anywhere near it. Declared here with the exact expression so it is an
     * accounted-for exception rather than a hole: a SECOND object URL in this
     * file, or any anchor forging, still fails.
     */
    allowedObjectUrls: ["objectUrl = URL.createObjectURL(data)"],
  },
] as const;

const callerSources = await Promise.all(CALLERS.map(async (c) => code(await read(c.file))));

describe("package file preview security", () => {
  it("renders author-controlled bytes as Monaco source", () => {
    expect(previewSource).toContain("<MonacoEditor");
    for (const sink of [
      "dangerouslySetInnerHTML",
      "<iframe",
      "srcDoc=",
      "<img",
      "<object",
      "<embed",
    ]) {
      expect(previewSource).not.toContain(sink);
    }
  });

  it.each(CALLERS.map((c, i) => [c.file, c, callerSources[i]!] as const))(
    "%s hands its bytes to the shared primitive and to nothing else",
    (file, caller, source) => {
      expect(source).toContain(`import { triggerBlobDownload } from ${caller.from}`);
      for (const call of caller.calls) {
        expect(dense(source)).toContain(dense(call));
      }
      // Every call site is accounted for — a new download added to a file
      // already on this list would otherwise ride in unexamined.
      expect(occurrences(source, "triggerBlobDownload(")).toBe(caller.calls.length);

      // The delegation is only worth anything if it is the ONLY route those
      // bytes have to the DOM: no hand-rolled anchor and no navigation to the
      // response. `createElement` covers the anchor forging specifically —
      // an object URL alone cannot download anything.
      for (const sink of [
        "createElement",
        "window.open(",
        "location.assign(",
        "location.replace(",
      ]) {
        expect(`${file}: ${source.includes(sink)}`).toBe(`${file}: false`);
      }

      // Object URLs are counted rather than banned outright: one caller builds
      // a legitimate non-download one (declared above, with its expression).
      const allowed = "allowedObjectUrls" in caller ? caller.allowedObjectUrls : [];
      expect(`${file}: ${occurrences(source, "createObjectURL(")}`).toBe(
        `${file}: ${allowed.length}`,
      );
      for (const expression of allowed) {
        expect(dense(source)).toContain(dense(expression));
      }
    },
  );

  it("scans every import site of the primitive — the list cannot silently fall behind", async () => {
    // The guard on the guard, and the reason "every caller" above is a claim
    // and not a hope: `CALLERS` is hand-written, so a FIFTH download hook would
    // be unscanned while every assertion in this file still passed. The set is
    // therefore read off the tree, not maintained a second time by hand.
    const srcRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);
    const importers: string[] = [];
    for await (const relative of new Bun.Glob("**/*.{ts,tsx}").scan(srcRoot)) {
      // The primitive itself, and the tests that import it to EXERCISE it —
      // the opposite of a sink.
      if (relative.includes("/test/") || relative === "lib/blob-download.ts") continue;
      if ((await Bun.file(`${srcRoot}${relative}`).text()).includes("triggerBlobDownload")) {
        importers.push(relative);
      }
    }

    const declared = CALLERS.map((c) =>
      decodeURIComponent(new URL(c.file, import.meta.url).pathname).slice(srcRoot.length),
    );
    expect(importers.sort()).toEqual(declared.sort());
  });

  it("downloads through an inert blob — the primitive pins the type and guards an empty body", () => {
    // Guard 1 (#1118): openapi-fetch short-circuits on `Content-Length: "0"`
    // before `parseAs`, so `data` is `undefined` on a successful zero-byte 200.
    // It has to become an empty blob part, never `new Blob([undefined])`.
    expect(dense(primitiveCode)).toContain(dense('new Blob([data ?? ""]'));

    // Guard 2: a `blob:` URL inherits the platform origin, so the blob's type
    // is what decides whether author-controlled bytes could ever be
    // interpreted. It is pinned inert ON THE BLOB — the whole construction, not
    // a loose `{ type: … }` that could sit next to a second, laxer blob.
    expect(dense(primitiveCode)).toContain(
      dense('new Blob([data ?? ""], { type: "application/octet-stream" })'),
    );

    // …and it is the ONLY media type the primitive names, so nothing echoes a
    // server- or uploader-supplied MIME through. Asserted over the media types
    // actually written in the source rather than over a count of `type:`, which
    // any unrelated TS annotation containing that token would have broken.
    const mediaTypes = [...primitiveCode.matchAll(/["'`]([a-z]+\/[a-z0-9.+*-]+)["'`]/gi)].map(
      (m) => m[1],
    );
    expect([...new Set(mediaTypes)]).toEqual(["application/octet-stream"]);

    // Exactly one object URL, built from that blob rather than from a raw
    // response body, and released after the click.
    expect(occurrences(primitiveCode, "createObjectURL(")).toBe(1);
    expect(dense(primitiveCode)).toContain(dense("URL.createObjectURL(new Blob("));
    expect(dense(primitiveCode)).toContain(dense("URL.revokeObjectURL(url)"));

    // The primitive downloads; it never navigates.
    expect(dense(primitiveCode)).toContain(dense("anchor.download = filename"));
    for (const sink of ["window.open(", "location.assign(", "location.replace(", "anchor.target"]) {
      expect(primitiveCode).not.toContain(sink);
    }
  });
});
