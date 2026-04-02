// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildMinimalZip, unzipAndNormalize } from "../../../src/services/package-storage.ts";

describe("package-storage integration", () => {
  const sampleManifest = {
    name: "test-flow",
    version: "1.0.0",
    type: "flow",
    description: "A test flow",
  };
  const sampleContent = "# Hello World\n\nThis is a test prompt.";

  // ── buildMinimalZip ──────────────────────────────────────────

  describe("buildMinimalZip", () => {
    it("returns a Buffer", () => {
      const result = buildMinimalZip(sampleManifest, sampleContent);
      expect(result).toBeInstanceOf(Buffer);
    });

    it("creates a valid ZIP with PK magic header bytes", () => {
      const zip = buildMinimalZip(sampleManifest, sampleContent);
      // ZIP PK magic: 0x50 0x4B (ASCII "PK")
      expect(zip[0]).toBe(0x50);
      expect(zip[1]).toBe(0x4b);
    });

    it("includes manifest.json", () => {
      const zip = buildMinimalZip(sampleManifest, sampleContent);
      const entries = unzipAndNormalize(zip);
      expect("manifest.json" in entries).toBe(true);
    });

    it("includes prompt.md by default", () => {
      const zip = buildMinimalZip(sampleManifest, sampleContent);
      const entries = unzipAndNormalize(zip);
      expect("prompt.md" in entries).toBe(true);
    });

    it("supports custom contentFileName", () => {
      const zip = buildMinimalZip(sampleManifest, sampleContent, "SKILL.md");
      const entries = unzipAndNormalize(zip);
      expect("SKILL.md" in entries).toBe(true);
      expect("prompt.md" in entries).toBe(false);
    });

    it("handles unicode characters in content", () => {
      const unicodeContent =
        "Bonjour le monde! Cafe\u0301 \u2615 \u{1F600} \u00E9\u00E8\u00EA\u00EB";
      const zip = buildMinimalZip(sampleManifest, unicodeContent);
      const entries = unzipAndNormalize(zip);
      const decoded = new TextDecoder().decode(entries["prompt.md"]);
      expect(decoded).toBe(unicodeContent);
    });

    it("handles empty content", () => {
      const zip = buildMinimalZip(sampleManifest, "");
      const entries = unzipAndNormalize(zip);
      const decoded = new TextDecoder().decode(entries["prompt.md"]);
      expect(decoded).toBe("");
    });
  });

  // ── unzipAndNormalize ────────────────────────────────────────

  describe("unzipAndNormalize", () => {
    it("parses a ZIP produced by buildMinimalZip", () => {
      const zip = buildMinimalZip(sampleManifest, sampleContent);
      const entries = unzipAndNormalize(zip);
      expect(typeof entries).toBe("object");
      expect(Object.keys(entries).length).toBeGreaterThanOrEqual(2);
    });

    it("throws on invalid ZIP data", () => {
      const garbage = Buffer.from("this is not a zip file at all");
      expect(() => unzipAndNormalize(garbage)).toThrow();
    });
  });

  // ── Round-trip ───────────────────────────────────────────────

  describe("round-trip: buildMinimalZip -> unzipAndNormalize", () => {
    it("preserves manifest content", () => {
      const zip = buildMinimalZip(sampleManifest, sampleContent);
      const entries = unzipAndNormalize(zip);
      const manifestRaw = new TextDecoder().decode(entries["manifest.json"]);
      const parsed = JSON.parse(manifestRaw);
      expect(parsed).toEqual(sampleManifest);
    });

    it("preserves prompt content", () => {
      const zip = buildMinimalZip(sampleManifest, sampleContent);
      const entries = unzipAndNormalize(zip);
      const promptRaw = new TextDecoder().decode(entries["prompt.md"]);
      expect(promptRaw).toBe(sampleContent);
    });
  });
});
