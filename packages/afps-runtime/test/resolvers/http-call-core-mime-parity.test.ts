// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Drift guard between `http-call-core.ts`'s local text/binary predicate and the
 * canonical one in `@appstrate/core/mime`.
 *
 * These two lists must answer identically, but `afps-runtime` deliberately
 * carries no runtime dependency on core (it ships as a portable bundle runner
 * and a standalone `afps` CLI; core sits beside it in the dependency graph, not
 * below it), so the list is mirrored rather than imported. Core IS a
 * devDependency here — enough to assert the mirror at build time without
 * putting core in a consumer's install.
 *
 * Three separate hand-rolled copies of this policy already drifted once: the
 * MCP copy did not know about the YAML family, and the sidecar's substring
 * match classified an XLSX as XML and corrupted every OOXML download. This test
 * is what makes the fourth divergence a red build instead of a support ticket.
 */

import { describe, expect, it } from "bun:test";
import { isTextShapedMime, normalizeMime, TEXT_SHAPED_MEDIA_TYPES } from "@appstrate/core/mime";
import { isTextLikeMimeType, TEXT_LIKE_MEDIA_TYPES } from "../../src/resolvers/http-call-core.ts";

describe("http-call-core text predicate ↔ @appstrate/core/mime parity", () => {
  it("mirrors core's media-type set exactly", () => {
    expect([...TEXT_LIKE_MEDIA_TYPES].sort()).toEqual([...TEXT_SHAPED_MEDIA_TYPES].sort());
  });

  it("agrees with core on every registered text media type", () => {
    for (const mime of TEXT_SHAPED_MEDIA_TYPES) {
      expect(isTextLikeMimeType(mime)).toBe(true);
      expect(isTextShapedMime(mime)).toBe(true);
    }
  });

  // Content types that must classify identically on both sides. The charset
  // rule is the ONE documented asymmetry (see below), so nothing here carries a
  // charset parameter.
  const CORPUS = [
    "text/plain",
    "text/csv",
    "application/json",
    "application/vnd.api+json",
    "application/xml",
    "application/atom+xml",
    "application/vnd.oai.openapi+yaml",
    "image/svg+xml",
    "application/octet-stream",
    "application/pdf",
    "image/png",
    "application/zip",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/epub+zip",
  ];

  it.each(CORPUS)("classifies %s the same way as core", (contentType) => {
    expect(isTextLikeMimeType(contentType)).toBe(isTextShapedMime(normalizeMime(contentType)));
  });

  it("keeps the documented charset asymmetry, and only that", () => {
    // `http_call` trusts an explicit charset parameter as a declaration of
    // textness whatever the base type; core's predicate is media-type-only
    // because its other consumers (upload sniff enforcement) must not let a
    // caller talk a binary past the magic-byte check by appending a charset.
    expect(isTextLikeMimeType("application/octet-stream; charset=utf-8")).toBe(true);
    expect(isTextShapedMime(normalizeMime("application/octet-stream; charset=utf-8"))).toBe(false);
  });

  it("never lets a charset parameter rescue an OOXML download", () => {
    // The asymmetry above is scoped to the charset signal. An OOXML container
    // has no charset, so both sides refuse it and the bytes survive.
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(isTextLikeMimeType(xlsx)).toBe(false);
    expect(isTextShapedMime(normalizeMime(xlsx))).toBe(false);
  });
});
