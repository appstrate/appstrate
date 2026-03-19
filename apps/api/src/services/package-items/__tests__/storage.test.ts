import { describe, test, expect } from "bun:test";
import { zipArtifact, unzipArtifact } from "@appstrate/core/zip";

/**
 * Tests for storage constants and ZIP round-trip used by the _system/ fallback.
 * Uses @appstrate/core directly (pure functions, no mocks needed).
 */

describe("system storage namespace", () => {
  test("_system produces expected S3 paths", () => {
    const ns = "_system";
    expect(`${ns}/providers/@test/gmail.afps`).toBe("_system/providers/@test/gmail.afps");
    expect(`${ns}/skills/@test/my-skill.afps`).toBe("_system/skills/@test/my-skill.afps");
  });
});

describe("ZIP round-trip for provider files", () => {
  test("can zip and unzip provider files with PROVIDER.md", () => {
    const files: Record<string, Uint8Array> = {
      "manifest.json": new TextEncoder().encode('{"name":"@test/gmail","type":"provider"}'),
      "PROVIDER.md": new TextEncoder().encode(
        "# Gmail API\n\nBase URL: https://gmail.googleapis.com",
      ),
    };

    const zip = zipArtifact(files, 6);
    const restored = unzipArtifact(zip);

    expect(Object.keys(restored)).toContain("manifest.json");
    expect(Object.keys(restored)).toContain("PROVIDER.md");
    expect(new TextDecoder().decode(restored["PROVIDER.md"])).toContain("# Gmail API");
  });

  test("manifest-only ZIP has exactly 1 file", () => {
    const files: Record<string, Uint8Array> = {
      "manifest.json": new TextEncoder().encode("{}"),
    };
    const zip = zipArtifact(files, 6);
    const restored = unzipArtifact(zip);
    expect(Object.keys(restored)).toHaveLength(1);
  });
});
