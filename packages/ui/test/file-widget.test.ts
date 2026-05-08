// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { fileMatchesAccept } from "../src/schema-form/file-widget.tsx";

const file = (name: string, type: string) => ({ name, type });

describe("fileMatchesAccept", () => {
  describe('"*/*" wildcard', () => {
    it("accepts any file regardless of MIME or extension (regression — BUGS-EVO §1.1)", () => {
      expect(fileMatchesAccept(file("doc.pdf", "application/pdf"), "*/*")).toBe(true);
      expect(fileMatchesAccept(file("img.png", "image/png"), "*/*")).toBe(true);
      expect(fileMatchesAccept(file("noext", ""), "*/*")).toBe(true);
      expect(fileMatchesAccept(file("blob", "application/octet-stream"), "*/*")).toBe(true);
    });

    it("accepts files even when MIME is empty (browser sometimes omits)", () => {
      expect(fileMatchesAccept(file("weird.xyz", ""), "*/*")).toBe(true);
    });
  });

  describe("extension match (.ext)", () => {
    it("accepts a file whose extension matches", () => {
      expect(fileMatchesAccept(file("report.pdf", "application/pdf"), ".pdf")).toBe(true);
    });

    it("is case-insensitive on both extension and accept token", () => {
      expect(fileMatchesAccept(file("REPORT.PDF", "application/pdf"), ".pdf")).toBe(true);
      expect(fileMatchesAccept(file("report.pdf", "application/pdf"), ".PDF")).toBe(true);
    });

    it("rejects a file whose extension differs", () => {
      expect(fileMatchesAccept(file("report.docx", "application/vnd…"), ".pdf")).toBe(false);
    });

    it("rejects a file with no extension", () => {
      expect(fileMatchesAccept(file("noext", "application/pdf"), ".pdf")).toBe(false);
    });
  });

  describe("MIME family (type/*)", () => {
    it("accepts any MIME in the family", () => {
      expect(fileMatchesAccept(file("a.png", "image/png"), "image/*")).toBe(true);
      expect(fileMatchesAccept(file("a.jpg", "image/jpeg"), "image/*")).toBe(true);
    });

    it("rejects MIME from a different family", () => {
      expect(fileMatchesAccept(file("a.pdf", "application/pdf"), "image/*")).toBe(false);
    });
  });

  describe("exact MIME (type/subtype)", () => {
    it("accepts an exact MIME match", () => {
      expect(fileMatchesAccept(file("a.pdf", "application/pdf"), "application/pdf")).toBe(true);
    });

    it("rejects a different subtype", () => {
      expect(fileMatchesAccept(file("a.json", "application/json"), "application/pdf")).toBe(false);
    });
  });

  describe("comma-separated lists", () => {
    it("accepts when any entry matches (mixed extensions + MIMEs)", () => {
      expect(fileMatchesAccept(file("a.pdf", "application/pdf"), ".docx, application/pdf")).toBe(
        true,
      );
      expect(fileMatchesAccept(file("a.png", "image/png"), ".pdf, image/*")).toBe(true);
    });

    it('accepts everything when "*/*" is anywhere in the list', () => {
      expect(fileMatchesAccept(file("a.exe", "application/x-msdownload"), ".pdf, */*")).toBe(true);
    });

    it("rejects when no entry matches", () => {
      expect(fileMatchesAccept(file("a.exe", "application/x-msdownload"), ".pdf, image/*")).toBe(
        false,
      );
    });

    it("ignores empty entries from extra commas / whitespace", () => {
      expect(fileMatchesAccept(file("a.pdf", "application/pdf"), " , .pdf , ")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("accepts everything when accept is empty / whitespace only", () => {
      expect(fileMatchesAccept(file("a.exe", "application/x-msdownload"), "")).toBe(true);
      expect(fileMatchesAccept(file("a.exe", "application/x-msdownload"), "   ")).toBe(true);
      expect(fileMatchesAccept(file("a.exe", "application/x-msdownload"), ",,")).toBe(true);
    });
  });
});
