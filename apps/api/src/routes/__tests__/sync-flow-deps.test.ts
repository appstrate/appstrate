import { describe, test, expect } from "bun:test";
import { extractDepsFromManifest, resolveManifestProviders } from "../../lib/manifest-utils.ts";

describe("extractDepsFromManifest", () => {
  test("extracts skills, tools, and providers from manifest.dependencies", () => {
    const result = extractDepsFromManifest({
      dependencies: {
        providers: { "@acme/gmail": "1.0.0", "@acme/slack": "2.0.0" },
        skills: { "skill-a": "1.0.0", "skill-b": "2.0.0" },
        tools: { "ext-1": "0.1.0" },
      },
    });

    expect(result.skillIds).toEqual(["skill-a", "skill-b"]);
    expect(result.toolIds).toEqual(["ext-1"]);
    expect(result.providerIds).toEqual(["@acme/gmail", "@acme/slack"]);
  });

  test("returns empty arrays when manifest.dependencies is absent", () => {
    const result = extractDepsFromManifest({});

    expect(result.skillIds).toEqual([]);
    expect(result.toolIds).toEqual([]);
    expect(result.providerIds).toEqual([]);
  });

  test("returns empty arrays when skills/tools/providers keys are absent", () => {
    const result = extractDepsFromManifest({
      dependencies: {},
    });

    expect(result.skillIds).toEqual([]);
    expect(result.toolIds).toEqual([]);
    expect(result.providerIds).toEqual([]);
  });

  test("filters out empty keys from skill/tool records", () => {
    const result = extractDepsFromManifest({
      dependencies: {
        skills: { "skill-a": "1.0.0", "": "*", "skill-b": "2.0.0" },
        tools: { "": "*", "ext-1": "0.1.0" },
      },
    });

    expect(result.skillIds).toEqual(["skill-a", "skill-b"]);
    expect(result.toolIds).toEqual(["ext-1"]);
  });

  test("handles skills-only manifest (no tools key)", () => {
    const result = extractDepsFromManifest({
      dependencies: { skills: { "skill-a": "1.0.0" } },
    });

    expect(result.skillIds).toEqual(["skill-a"]);
    expect(result.toolIds).toEqual([]);
    expect(result.providerIds).toEqual([]);
  });

  test("handles tools-only manifest (no skills key)", () => {
    const result = extractDepsFromManifest({
      dependencies: { tools: { "ext-1": "0.1.0" } },
    });

    expect(result.skillIds).toEqual([]);
    expect(result.toolIds).toEqual(["ext-1"]);
  });
});

describe("resolveManifestProviders", () => {
  test("merges dependencies.providers with providersConfiguration", () => {
    const result = resolveManifestProviders({
      dependencies: {
        providers: { "@acme/gmail": "1.0.0", "@acme/slack": "2.0.0" },
      },
      providersConfiguration: {
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

  test("returns empty array when no providers", () => {
    const result = resolveManifestProviders({});
    expect(result).toEqual([]);
  });
});
