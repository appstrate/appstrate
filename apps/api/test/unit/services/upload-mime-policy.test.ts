// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `sniffedMimeMatchesDeclared` — the declared-vs-sniffed MIME
 * compatibility policy shared by the staged-upload consume path and the inline
 * `data:` URI input path. Pins the Marcel/Tika-style ZIP-container refinement
 * (a sniffed `application/zip` satisfies a declared OOXML/ODF type, because
 * `file-type`'s head sample cannot always reach the archive's identifying
 * entry) without weakening the exact-match rule outside that family.
 */

import { describe, it, expect } from "bun:test";
import { sniffedMimeMatchesDeclared } from "../../../src/services/uploads.ts";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("sniffedMimeMatchesDeclared", () => {
  it("exact match passes", () => {
    expect(sniffedMimeMatchesDeclared("application/pdf", "application/pdf")).toBe(true);
    expect(sniffedMimeMatchesDeclared(XLSX, XLSX)).toBe(true);
  });

  it("undefined sniff never matches", () => {
    expect(sniffedMimeMatchesDeclared("application/pdf", undefined)).toBe(false);
    expect(sniffedMimeMatchesDeclared(XLSX, undefined)).toBe(false);
  });

  it("sniffed application/zip refines into a declared ZIP-container type", () => {
    expect(sniffedMimeMatchesDeclared(XLSX, "application/zip")).toBe(true);
    expect(sniffedMimeMatchesDeclared(DOCX, "application/zip")).toBe(true);
    expect(
      sniffedMimeMatchesDeclared("application/vnd.oasis.opendocument.text", "application/zip"),
    ).toBe(true);
    expect(sniffedMimeMatchesDeclared("application/epub+zip", "application/zip")).toBe(true);
  });

  it("declared application/zip accepts a sniffed specific container type", () => {
    // file-type recognises some zips as their specific format (jar, xlsx) —
    // a user uploading one under the generic declared type must not be
    // rejected for the sniffer being MORE precise than the declaration.
    expect(sniffedMimeMatchesDeclared("application/zip", XLSX)).toBe(true);
    expect(sniffedMimeMatchesDeclared("application/zip", "application/java-archive")).toBe(true);
  });

  it("sniffed application/zip does NOT satisfy a non-container declaration", () => {
    expect(sniffedMimeMatchesDeclared("application/pdf", "application/zip")).toBe(false);
    expect(sniffedMimeMatchesDeclared("image/png", "application/zip")).toBe(false);
  });

  it("non-zip mismatches still fail", () => {
    expect(sniffedMimeMatchesDeclared("application/pdf", "image/png")).toBe(false);
    expect(sniffedMimeMatchesDeclared(XLSX, "application/pdf")).toBe(false);
    // gzip/rar are NOT zip containers — no family pass-through.
    expect(sniffedMimeMatchesDeclared(XLSX, "application/gzip")).toBe(false);
  });
});
