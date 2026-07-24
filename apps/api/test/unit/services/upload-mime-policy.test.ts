// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared MIME policy module (`services/mime-policy.ts`) — the
 * ONE declared-vs-sniffed compatibility policy consumed by the staged-upload
 * consume path, the inline `data:` URI input path, AND agent-output ingestion.
 * Pins the Marcel/Tika-style ZIP-container refinement (a sniffed `application/zip`
 * satisfies a declared OOXML/ODF type, because `file-type`'s head sample cannot
 * always reach the archive's identifying entry) without weakening the exact-match
 * rule outside that family; plus the agent-output relabel asymmetry.
 */

import { describe, it, expect } from "bun:test";
import {
  sniffedMimeMatchesDeclared,
  shouldEnforceSniffedMime,
  resolveAgentOutputMime,
} from "../../../src/services/mime-policy.ts";

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

describe("shouldEnforceSniffedMime", () => {
  it("enforces concrete sniffable binary declarations", () => {
    expect(shouldEnforceSniffedMime("application/pdf")).toBe(true);
    expect(shouldEnforceSniffedMime("image/png")).toBe(true);
    expect(shouldEnforceSniffedMime(XLSX)).toBe(true);
  });

  it("skips the escape hatches (octet-stream, empty, text-ish)", () => {
    expect(shouldEnforceSniffedMime("application/octet-stream")).toBe(false);
    expect(shouldEnforceSniffedMime("")).toBe(false);
    expect(shouldEnforceSniffedMime("text/plain")).toBe(false);
    expect(shouldEnforceSniffedMime("application/json")).toBe(false);
    expect(shouldEnforceSniffedMime("image/svg+xml")).toBe(false);
    expect(shouldEnforceSniffedMime("application/vnd.custom+xml")).toBe(false);
  });
});

describe("resolveAgentOutputMime (relabel asymmetry — agent outputs are never rejected)", () => {
  it("keeps the declared mime when the sniff matches or refines it", () => {
    expect(resolveAgentOutputMime("application/pdf", "application/pdf")).toBe("application/pdf");
    // Container refinement: a declared xlsx sniffing as generic zip stays xlsx.
    expect(resolveAgentOutputMime(XLSX, "application/zip")).toBe(XLSX);
  });

  it("keeps the declared mime when the bytes are unsniffable", () => {
    // No magic signature → trust the declaration (text, json, …).
    expect(resolveAgentOutputMime("text/csv", undefined)).toBe("text/csv");
    expect(resolveAgentOutputMime("application/json", undefined)).toBe("application/json");
  });

  it("RELABELS to the sniffed type on a genuine mismatch", () => {
    // Declared text/plain but the bytes are a PNG → store image/png (honest).
    expect(resolveAgentOutputMime("text/plain", "image/png")).toBe("image/png");
    expect(resolveAgentOutputMime("application/pdf", "image/png")).toBe("image/png");
  });

  it("normalizes the declared mime (strips params, lowercases)", () => {
    expect(resolveAgentOutputMime("TEXT/Plain; charset=utf-8", undefined)).toBe("text/plain");
  });
});
