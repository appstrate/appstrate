import { describe, test, expect } from "bun:test";
import { extractDepsFromManifest } from "../../lib/manifest-utils.ts";

describe("extractDepsFromManifest", () => {
  test("extracts skills and extensions from manifest.requires", () => {
    const result = extractDepsFromManifest({
      requires: {
        skills: ["skill-a", "skill-b"],
        extensions: ["ext-1"],
      },
    });

    expect(result.skillIds).toEqual(["skill-a", "skill-b"]);
    expect(result.extensionIds).toEqual(["ext-1"]);
  });

  test("returns empty arrays when manifest.requires is absent", () => {
    const result = extractDepsFromManifest({});

    expect(result.skillIds).toEqual([]);
    expect(result.extensionIds).toEqual([]);
  });

  test("returns empty arrays when skills/extensions keys are absent", () => {
    const result = extractDepsFromManifest({
      requires: { services: [] },
    });

    expect(result.skillIds).toEqual([]);
    expect(result.extensionIds).toEqual([]);
  });

  test("filters out falsy values from skill/extension arrays", () => {
    const result = extractDepsFromManifest({
      requires: {
        skills: ["skill-a", "", null, undefined, "skill-b"],
        extensions: [null, "ext-1", ""],
      },
    });

    expect(result.skillIds).toEqual(["skill-a", "skill-b"]);
    expect(result.extensionIds).toEqual(["ext-1"]);
  });

  test("handles skills-only manifest (no extensions key)", () => {
    const result = extractDepsFromManifest({
      requires: { skills: ["skill-a"] },
    });

    expect(result.skillIds).toEqual(["skill-a"]);
    expect(result.extensionIds).toEqual([]);
  });

  test("handles extensions-only manifest (no skills key)", () => {
    const result = extractDepsFromManifest({
      requires: { extensions: ["ext-1"] },
    });

    expect(result.skillIds).toEqual([]);
    expect(result.extensionIds).toEqual(["ext-1"]);
  });
});
