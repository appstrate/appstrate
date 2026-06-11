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

  it("sniffed application/x-cfb refines into a declared legacy Office type", () => {
    // file-type identifies the OLE2 container magic but never refines it to
    // the concrete format — every legitimate .doc/.xls/.ppt sniffs as x-cfb.
    expect(sniffedMimeMatchesDeclared("application/msword", "application/x-cfb")).toBe(true);
    expect(sniffedMimeMatchesDeclared("application/vnd.ms-excel", "application/x-cfb")).toBe(true);
    expect(sniffedMimeMatchesDeclared("application/vnd.ms-powerpoint", "application/x-cfb")).toBe(
      true,
    );
    expect(sniffedMimeMatchesDeclared("application/x-cfb", "application/x-cfb")).toBe(true);
  });

  it("container families do not cross", () => {
    // A zip member never refines from the cfb generic and vice versa.
    expect(sniffedMimeMatchesDeclared(XLSX, "application/x-cfb")).toBe(false);
    expect(sniffedMimeMatchesDeclared("application/vnd.ms-excel", "application/zip")).toBe(false);
    expect(sniffedMimeMatchesDeclared("application/pdf", "application/x-cfb")).toBe(false);
  });

  it("two specific container types never satisfy each other", () => {
    // Refinement is parent↔child only — when the sniffer DID identify the
    // concrete format, a different concrete declaration is a real mismatch.
    // Notably keeps macro-enabled documents out of macro-free declarations.
    expect(sniffedMimeMatchesDeclared(XLSX, DOCX)).toBe(false);
    expect(sniffedMimeMatchesDeclared(XLSX, "application/vnd.ms-excel.sheet.macroenabled.12")).toBe(
      false,
    );
    expect(
      sniffedMimeMatchesDeclared(DOCX, "application/vnd.ms-word.document.macroenabled.12"),
    ).toBe(false);
    expect(sniffedMimeMatchesDeclared("application/epub+zip", XLSX)).toBe(false);
  });
});
