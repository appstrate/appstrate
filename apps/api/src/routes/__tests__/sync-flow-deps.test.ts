import { describe, test, expect } from "bun:test";
import { extractDepsFromManifest, resolveManifestServices } from "../../lib/manifest-utils.ts";

describe("extractDepsFromManifest", () => {
  test("extracts skills, extensions, and providers from manifest.requires", () => {
    const result = extractDepsFromManifest({
      requires: {
        services: { "@acme/gmail": "1.0.0", "@acme/slack": "2.0.0" },
        skills: { "skill-a": "1.0.0", "skill-b": "2.0.0" },
        extensions: { "ext-1": "0.1.0" },
      },
    });

    expect(result.skillIds).toEqual(["skill-a", "skill-b"]);
    expect(result.extensionIds).toEqual(["ext-1"]);
    expect(result.providerIds).toEqual(["@acme/gmail", "@acme/slack"]);
  });

  test("returns empty arrays when manifest.requires is absent", () => {
    const result = extractDepsFromManifest({});

    expect(result.skillIds).toEqual([]);
    expect(result.extensionIds).toEqual([]);
    expect(result.providerIds).toEqual([]);
  });

  test("returns empty arrays when skills/extensions/services keys are absent", () => {
    const result = extractDepsFromManifest({
      requires: {},
    });

    expect(result.skillIds).toEqual([]);
    expect(result.extensionIds).toEqual([]);
    expect(result.providerIds).toEqual([]);
  });

  test("filters out empty keys from skill/extension records", () => {
    const result = extractDepsFromManifest({
      requires: {
        skills: { "skill-a": "1.0.0", "": "*", "skill-b": "2.0.0" },
        extensions: { "": "*", "ext-1": "0.1.0" },
      },
    });

    expect(result.skillIds).toEqual(["skill-a", "skill-b"]);
    expect(result.extensionIds).toEqual(["ext-1"]);
  });

  test("handles skills-only manifest (no extensions key)", () => {
    const result = extractDepsFromManifest({
      requires: { skills: { "skill-a": "1.0.0" } },
    });

    expect(result.skillIds).toEqual(["skill-a"]);
    expect(result.extensionIds).toEqual([]);
    expect(result.providerIds).toEqual([]);
  });

  test("handles extensions-only manifest (no skills key)", () => {
    const result = extractDepsFromManifest({
      requires: { extensions: { "ext-1": "0.1.0" } },
    });

    expect(result.skillIds).toEqual([]);
    expect(result.extensionIds).toEqual(["ext-1"]);
  });
});

describe("resolveManifestServices", () => {
  test("merges requires.services with servicesConfiguration", () => {
    const result = resolveManifestServices({
      requires: {
        services: { "@acme/gmail": "1.0.0", "@acme/slack": "2.0.0" },
      },
      servicesConfiguration: {
        "@acme/gmail": { scopes: ["gmail.readonly"], connectionMode: "admin" },
      },
    } as Record<string, unknown>);

    expect(result).toEqual([
      {
        id: "@acme/gmail",
        provider: "@acme/gmail",
        scopes: ["gmail.readonly"],
        connectionMode: "admin",
      },
      { id: "@acme/slack", provider: "@acme/slack", scopes: undefined, connectionMode: undefined },
    ]);
  });

  test("returns empty array when no services", () => {
    const result = resolveManifestServices({});
    expect(result).toEqual([]);
  });
});
