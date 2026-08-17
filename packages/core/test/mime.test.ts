// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  normalizeMime,
  isTextShapedMime,
  isTextShapedContentType,
  TEXT_SHAPED_MEDIA_TYPES,
} from "../src/mime.ts";

describe("normalizeMime", () => {
  it("strips parameters, trims and lowercases", () => {
    expect(normalizeMime("Text/CSV; charset=UTF-8")).toBe("text/csv");
    expect(normalizeMime("  application/json  ")).toBe("application/json");
    expect(normalizeMime("multipart/form-data; boundary=--x")).toBe("multipart/form-data");
  });

  it("maps absent / empty input to the empty string", () => {
    expect(normalizeMime(undefined)).toBe("");
    expect(normalizeMime(null)).toBe("");
    expect(normalizeMime("")).toBe("");
  });
});

describe("isTextShapedMime", () => {
  it("accepts the text/* family", () => {
    for (const m of ["text/plain", "text/csv", "text/html", "text/markdown"]) {
      expect(isTextShapedMime(m)).toBe(true);
    }
  });

  it("accepts every registered text media type", () => {
    for (const m of TEXT_SHAPED_MEDIA_TYPES) {
      expect(isTextShapedMime(m)).toBe(true);
    }
  });

  it("accepts RFC 6839 structured suffixes", () => {
    for (const m of [
      "application/vnd.api+json",
      "application/problem+json",
      "application/atom+xml",
      "application/rss+xml",
      "application/xhtml+xml",
      "application/vnd.oai.openapi+yaml",
    ]) {
      expect(isTextShapedMime(m)).toBe(true);
    }
  });

  // The regression this module exists for: the sidecar used to match
  // `contentType.includes("xml")`, which classifies an XLSX (a ZIP binary whose
  // subtype merely contains "xml") as text. The lossy UTF-8 decode that follows
  // replaces invalid bytes with U+FFFD and destroys the file.
  it("rejects OOXML and OpenDocument containers despite 'xml' in the subtype", () => {
    for (const m of [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-excel.sheet.macroenabled.12",
      "application/vnd.oasis.opendocument.spreadsheet",
    ]) {
      expect(isTextShapedMime(m)).toBe(false);
    }
  });

  it("rejects binary types whose subtype merely contains 'json' or 'xml'", () => {
    for (const m of ["application/x-jsonnet-binary", "video/x-xml-container"]) {
      expect(isTextShapedMime(m)).toBe(false);
    }
  });

  it("keeps application/octet-stream on the binary path", () => {
    // The explicit "opaque blob" marker. Its bytes may happen to be ASCII; the
    // caller asked for bytes and must get bytes.
    expect(isTextShapedMime("application/octet-stream")).toBe(false);
  });

  it("rejects common binary formats", () => {
    for (const m of ["application/pdf", "image/png", "application/zip", "audio/mpeg"]) {
      expect(isTextShapedMime(m)).toBe(false);
    }
  });

  it("expects a normalized value — a parameterized string never matches", () => {
    expect(isTextShapedMime("application/json; charset=utf-8")).toBe(false);
    expect(isTextShapedMime(normalizeMime("application/json; charset=utf-8"))).toBe(true);
  });
});

describe("isTextShapedContentType", () => {
  it("normalizes before classifying", () => {
    expect(isTextShapedContentType("application/json; charset=utf-8")).toBe(true);
    expect(isTextShapedContentType("Text/Plain; charset=ISO-8859-1")).toBe(true);
  });

  it("treats an absent or empty header as binary", () => {
    expect(isTextShapedContentType(undefined)).toBe(false);
    expect(isTextShapedContentType(null)).toBe(false);
    expect(isTextShapedContentType("")).toBe(false);
    expect(isTextShapedContentType("   ")).toBe(false);
  });

  it("rejects the OOXML content type Google Drive serves for .xlsx downloads", () => {
    expect(
      isTextShapedContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe(false);
  });
});
