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
 * The download half is asserted in two halves — the reader DELEGATES, and the
 * primitive DECIDES — rather than as one literal expression inside the reader.
 * Pinning the inline form asserts where a check is written instead of that it
 * happens, and reads the move of that check into one shared place as a
 * regression; the manifest sink scan hit exactly that (commit 3a3ffadb7).
 * `lib/test/blob-download.test.ts` covers the primitive behaviorally.
 */

import { describe, it, expect } from "bun:test";

const previewSource = await Bun.file(
  decodeURIComponent(new URL("../package-files/file-preview.tsx", import.meta.url).pathname),
).text();
const downloadSource = await Bun.file(
  decodeURIComponent(new URL("../package-files/use-package-file.ts", import.meta.url).pathname),
).text();
const primitiveSource = await Bun.file(
  decodeURIComponent(new URL("../../lib/blob-download.ts", import.meta.url).pathname),
).text();

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

const downloadCode = code(downloadSource);
const primitiveCode = code(primitiveSource);

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

  it("hands package bytes to the shared download primitive and to nothing else", () => {
    expect(downloadCode).toContain('import { triggerBlobDownload } from "../../lib/blob-download"');
    expect(dense(downloadCode)).toContain(dense("triggerBlobDownload(data, baseName(path))"));
    // The delegation is only worth anything if it is the ONLY route the bytes
    // have to the DOM: no second object URL, no hand-rolled anchor, and no
    // navigation to the response.
    for (const sink of [
      "createObjectURL",
      "createElement",
      "window.open(",
      "location.assign(",
      "location.replace(",
    ]) {
      expect(downloadCode).not.toContain(sink);
    }
  });

  it("downloads through an inert blob — the primitive pins the type and guards an empty body", () => {
    // Guard 1 (#1118): openapi-fetch short-circuits on `Content-Length: "0"`
    // before `parseAs`, so `data` is `undefined` on a successful zero-byte 200.
    // It has to become an empty blob part, never `new Blob([undefined])`.
    expect(dense(primitiveCode)).toContain(dense('new Blob([data ?? ""]'));

    // Guard 2: a `blob:` URL inherits the platform origin, so the blob's type
    // is what decides whether author-controlled bytes could ever be
    // interpreted. It is pinned inert, and it is the ONLY type the primitive
    // names — nothing echoes a server- or uploader-supplied MIME through.
    expect(dense(primitiveCode)).toContain(dense('{ type: "application/octet-stream" }'));
    expect(primitiveCode.match(/type:/g) ?? []).toHaveLength(1);

    // Exactly one object URL, built from that blob rather than from a raw
    // response body, and released after the click.
    expect(primitiveCode.match(/createObjectURL\(/g) ?? []).toHaveLength(1);
    expect(dense(primitiveCode)).toContain(dense("URL.createObjectURL(new Blob("));
    expect(dense(primitiveCode)).toContain(dense("URL.revokeObjectURL(url)"));

    // The primitive downloads; it never navigates.
    expect(dense(primitiveCode)).toContain(dense("a.download = filename"));
    for (const sink of ["window.open(", "location.assign(", "location.replace(", "a.target"]) {
      expect(primitiveCode).not.toContain(sink);
    }
  });
});
