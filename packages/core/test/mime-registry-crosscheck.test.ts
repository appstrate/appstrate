// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-check of {@link TEXT_SHAPED_MEDIA_TYPES} against `mime-db`, the IANA /
 * Apache / nginx media-type registry that powers `mime-types` and Express.
 *
 * `mime-db` is a **devDependency and a test-only oracle**, never a runtime
 * source of truth. It cannot answer our question:
 *
 *  - Its `charset` field is set on 11 of 132 `text/*` entries and on 2 of the
 *    18 media types we classify as text. `mime-types.charset()` returns `false`
 *    for `application/xml`, `application/atom+xml` and every vendor `+json`.
 *  - Its `compressible` field answers "does gzip help?", not "is this text".
 *    It is `true` for `application/octet-stream` — the ONE type this codebase
 *    documents as must-stay-binary (issues #149 / #151) — and for `font/ttf`,
 *    `image/bmp`, `image/vnd.adobe.photoshop`, `application/x-tar`.
 *  - Streaming-JSON and YAML spellings we must support (`application/x-ndjson`,
 *    `application/jsonl`, `application/x-yaml`, `application/csv`) are absent
 *    from it entirely.
 *
 * What `compressible: false` IS reliable for is the negative direction: the
 * registry sets it on binary containers (OOXML, OpenDocument, PDF, PNG, ZIP,
 * EPUB, JAR). That makes it a cheap guard against the exact bug this predicate
 * exists to prevent — a ZIP-container media type sneaking into the text list —
 * INCLUDING for formats nobody thought to enumerate in `mime.test.ts`.
 *
 * Both directions are asserted. The positive control matters: without it, a
 * `mime-db` restructure that made every lookup return `undefined` would leave
 * the guard silently passing while checking nothing.
 */

import { describe, expect, it } from "bun:test";
import db from "mime-db";
import { TEXT_SHAPED_MEDIA_TYPES, isTextShapedMime } from "../src/mime.ts";

/**
 * Media types the registry marks as incompressible — i.e. already-compressed
 * binary containers. Used as the positive control: these MUST be found in
 * `mime-db` with `compressible: false`, proving the lookup below is live.
 */
const KNOWN_INCOMPRESSIBLE = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/pdf",
  "image/png",
  "application/zip",
  "application/epub+zip",
  "application/java-archive",
];

describe("TEXT_SHAPED_MEDIA_TYPES × mime-db", () => {
  it("reads live registry data (positive control)", () => {
    // If this fails, `mime-db` changed shape and the guard below is vacuous.
    expect(Object.keys(db).length).toBeGreaterThan(1000);
    for (const mime of KNOWN_INCOMPRESSIBLE) {
      expect(db[mime]?.compressible).toBe(false);
    }
  });

  it("lists no media type the registry marks as an incompressible binary", () => {
    // The guard. `compressible: false` in mime-db means "already-compressed
    // container" — a format that can never be decoded as text. An entry that is
    // absent or has no `compressible` field is NOT a failure: the registry does
    // not know every spelling we support (see the module doc).
    const offenders = [...TEXT_SHAPED_MEDIA_TYPES].filter(
      (mime) => db[mime]?.compressible === false,
    );
    expect(offenders).toEqual([]);
  });

  it("classifies every incompressible registry entry as binary", () => {
    // Broader sweep than the hand-written list in `mime.test.ts`: walk the whole
    // registry and assert the predicate never calls an incompressible type text.
    // `image/svg+xml` is the documented exception — mime-db marks it
    // compressible, so it does not appear here, but state the intent anyway.
    const misclassified = Object.entries(db)
      .filter(([, entry]) => entry.compressible === false)
      .map(([mime]) => mime)
      .filter((mime) => isTextShapedMime(mime));
    expect(misclassified).toEqual([]);
  });

  it("would have caught the OOXML regression this predicate exists to prevent", () => {
    // Regression anchor: `contentType.includes("xml")` classified an XLSX as
    // text, the lossy UTF-8 decode replaced its invalid bytes with U+FFFD, and
    // the re-encode wrote that corruption to the workspace.
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(db[xlsx]?.compressible).toBe(false);
    expect(isTextShapedMime(xlsx)).toBe(false);
    expect(TEXT_SHAPED_MEDIA_TYPES.has(xlsx)).toBe(false);
  });
});
