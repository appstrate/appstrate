// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `isTextLikeMimeType` — the predicate that decides whether an `http_call`
 * response body is UTF-8 decoded or kept as raw bytes.
 *
 * A false positive here is data loss, not a mislabel: the decode is lossy
 * (`fatal: false` → U+FFFD) and irreversible once re-encoded. That is exactly
 * how a substring `includes("xml")` match once corrupted every OOXML file
 * downloaded through `responseMode.toFile` — an XLSX is a ZIP.
 *
 * This file replaces `http-call-core-mime-parity.test.ts`, which asserted that
 * a hand-copy of the media-type set agreed with `@appstrate/core/mime`. The
 * copy is gone (both layers now read `@appstrate/afps-shared/mime`), so a
 * parity assertion over a single source would assert nothing. What still needs
 * pinning is the behaviour this module adds on top of the shared predicate:
 * the `http_call`-only charset rule, and the fact that it cannot rescue a
 * binary container.
 */

import { describe, expect, it } from "bun:test";
import { isTextLikeMimeType } from "../../src/resolvers/http-call-core.ts";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("isTextLikeMimeType", () => {
  it.each([
    "text/plain",
    "text/csv",
    "application/json",
    "application/vnd.api+json",
    "application/xml",
    "application/atom+xml",
    "application/vnd.oai.openapi+yaml",
    "image/svg+xml",
    "application/x-ndjson",
    "application/yaml",
    "application/x-www-form-urlencoded",
  ])("decodes %s as text", (contentType) => {
    expect(isTextLikeMimeType(contentType)).toBe(true);
  });

  it.each([
    "application/octet-stream",
    "application/pdf",
    "image/png",
    "application/zip",
    XLSX,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.file",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/epub+zip",
  ])("keeps %s as bytes", (contentType) => {
    expect(isTextLikeMimeType(contentType)).toBe(false);
  });

  it("treats an explicit charset parameter as a declaration of textness", () => {
    // The one rule this module adds over `@appstrate/afps-shared/mime`: an
    // upstream that bothers to declare a charset is telling us the body is
    // text, whatever the base type. The shared predicate stays media-type-only
    // because its other consumer (upload sniff enforcement) must not let a
    // caller talk a binary past the magic-byte check by appending a charset.
    expect(isTextLikeMimeType("application/octet-stream; charset=utf-8")).toBe(true);
    expect(isTextLikeMimeType("application/json;charset=UTF-8")).toBe(true);
    expect(isTextLikeMimeType("text/csv; charset=ISO-8859-1")).toBe(true);
  });

  it("never lets a charset parameter rescue an OOXML download", () => {
    // The asymmetry above is scoped to an actually-present charset signal. A
    // real OOXML response carries none, so the bytes survive — the regression
    // this predicate exists to prevent.
    expect(isTextLikeMimeType(XLSX)).toBe(false);
    expect(isTextLikeMimeType(`${XLSX}; boundary=x`)).toBe(false);
  });

  it("is case-insensitive and parameter-tolerant", () => {
    expect(isTextLikeMimeType("APPLICATION/JSON")).toBe(true);
    expect(isTextLikeMimeType("  application/json  ")).toBe(true);
    expect(isTextLikeMimeType("Image/PNG")).toBe(false);
  });

  it("classifies an absent Content-Type as binary", () => {
    // The safe default for unknown bytes is the binary path.
    expect(isTextLikeMimeType(null)).toBe(false);
    expect(isTextLikeMimeType(undefined)).toBe(false);
    expect(isTextLikeMimeType("")).toBe(false);
  });
});
