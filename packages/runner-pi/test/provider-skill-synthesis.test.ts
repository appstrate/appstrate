// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  ProviderSkillSynthesisError,
  deriveSkillName,
  synthesizeProviderSkill,
} from "../src/provider-skill-synthesis.ts";
import { makeBundlePackage } from "./helpers.ts";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("deriveSkillName", () => {
  it("normalises a scoped package id", () => {
    expect(deriveSkillName("@appstrate/gmail")).toBe("provider-appstrate-gmail");
  });

  it("handles unscoped names", () => {
    expect(deriveSkillName("notion")).toBe("provider-notion");
  });

  it("lowercases and replaces non-alphanumerics with hyphens", () => {
    expect(deriveSkillName("@Org/Foo_Bar.Baz")).toBe("provider-org-foo-bar-baz");
  });

  it("collapses runs of separators into a single hyphen", () => {
    expect(deriveSkillName("@a//b__c--d")).toBe("provider-a-b-c-d");
  });

  it("strips leading and trailing hyphens from the normalised body", () => {
    expect(deriveSkillName("@scope/--name--")).toBe("provider-scope-name");
  });

  it("preserves digits", () => {
    expect(deriveSkillName("@scope/v2-api")).toBe("provider-scope-v2-api");
  });

  it("truncates to 64 characters and re-validates", () => {
    const name = deriveSkillName("@verylongscope/" + "a".repeat(80));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith("provider-verylongscope-")).toBe(true);
    expect(name.endsWith("-")).toBe(false);
  });

  it("throws on empty input", () => {
    expect(() => deriveSkillName("")).toThrow(ProviderSkillSynthesisError);
  });

  it("throws on whitespace-only input", () => {
    expect(() => deriveSkillName("   ")).toThrow(ProviderSkillSynthesisError);
  });

  it("throws when no usable characters remain after normalisation", () => {
    expect(() => deriveSkillName("@///___")).toThrow(ProviderSkillSynthesisError);
  });
});

describe("synthesizeProviderSkill", () => {
  it("includes frontmatter, metadata block, and PROVIDER.md body", () => {
    const pkg = makeBundlePackage(
      "@appstrate/gmail",
      "1.0.0",
      "provider",
      { "PROVIDER.md": "# Gmail API\n\nBase URL: https://gmail.googleapis.com/" },
      {
        name: "Gmail",
        description: "Send and read mail via Google Gmail",
        definition: {
          authMode: "oauth2",
          authorizedUris: ["https://gmail.googleapis.com/**"],
          docsUrl: "https://developers.google.com/gmail/api",
        },
      },
    );

    const { skillName, content } = synthesizeProviderSkill(pkg);
    const text = decode(content);

    expect(skillName).toBe("provider-appstrate-gmail");
    expect(text).toContain(`name: provider-appstrate-gmail`);
    expect(text).toContain(`Gmail API.`);
    expect(text).toContain(`Send and read mail via Google Gmail.`);
    expect(text).toContain(
      `READ this skill before any provider_call(providerId=\\"@appstrate/gmail\\").`,
    );
    expect(text).toContain("## Provider metadata");
    expect(text).toContain("- **providerId**: `@appstrate/gmail`");
    expect(text).toContain("- **displayName**: Gmail");
    expect(text).toContain("- **authMode**: oauth2");
    expect(text).toContain("- **authorizedUris**: https://gmail.googleapis.com/**");
    expect(text).toContain("- **docsUrl**: https://developers.google.com/gmail/api");
    expect(text).toContain("## API documentation");
    expect(text).toContain("# Gmail API");
    expect(text).toContain("Base URL: https://gmail.googleapis.com/");
  });

  it("falls back to a docs pointer when PROVIDER.md is absent", () => {
    const pkg = makeBundlePackage(
      "@scope/notion",
      "1.0.0",
      "provider",
      {},
      {
        name: "Notion",
        description: "Notion workspace API",
        definition: {
          authMode: "oauth2",
          docsUrl: "https://developers.notion.com/reference",
        },
      },
    );

    const text = decode(synthesizeProviderSkill(pkg).content);
    expect(text).toContain("## API documentation");
    expect(text).toContain("No bundled PROVIDER.md");
    expect(text).toContain("https://developers.notion.com/reference");
  });

  it("renders allowAllUris instead of authorizedUris when set", () => {
    const pkg = makeBundlePackage(
      "@x/open",
      "1.0.0",
      "provider",
      {},
      {
        name: "Open",
        definition: { authMode: "api_key", allowAllUris: true },
      },
    );

    const text = decode(synthesizeProviderSkill(pkg).content);
    expect(text).toContain("- **authorizedUris**: all public URLs (`allowAllUris: true`)");
  });

  it("omits the description middle clause when manifest.description is missing", () => {
    const pkg = makeBundlePackage(
      "@x/bare",
      "1.0.0",
      "provider",
      {},
      {
        name: "Bare",
        definition: { authMode: "api_key" },
      },
    );

    const text = decode(synthesizeProviderSkill(pkg).content);
    expect(text).toContain(
      `description: "Bare API. READ this skill before any provider_call(providerId=\\"@x/bare\\")."`,
    );
  });

  it("strips a trailing period from manifest.description to avoid '..'", () => {
    const pkg = makeBundlePackage(
      "@x/dot",
      "1.0.0",
      "provider",
      {},
      { name: "Dot", description: "Trailing period.", definition: { authMode: "api_key" } },
    );

    const text = decode(synthesizeProviderSkill(pkg).content);
    expect(text).toContain("Trailing period. READ this skill");
    expect(text).not.toContain("Trailing period.. READ");
  });

  it("drops the manifest.description clause when the synthesised description exceeds 1024 chars", () => {
    const longDescription = "x".repeat(2000);
    const pkg = makeBundlePackage(
      "@x/long",
      "1.0.0",
      "provider",
      {},
      { name: "Long", description: longDescription, definition: { authMode: "api_key" } },
    );

    const text = decode(synthesizeProviderSkill(pkg).content);
    const match = text.match(/^description: "(.+)"$/m);
    if (!match) throw new Error("description line not found in synthesised SKILL.md");
    const description = match[1] ?? "";
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toContain("READ this skill before any provider_call");
    expect(description).not.toContain("xxxxxxxxxx");
  });

  it("falls back to the package id when manifest.name is missing", () => {
    const pkg = makeBundlePackage(
      "@x/anon",
      "1.0.0",
      "provider",
      {},
      { definition: { authMode: "api_key" } },
    );

    const text = decode(synthesizeProviderSkill(pkg).content);
    expect(text).toContain("- **displayName**: @x/anon");
  });

  it("tolerates a missing definition object", () => {
    const pkg = makeBundlePackage("@x/no-def", "1.0.0", "provider", {}, { name: "NoDef" });

    const text = decode(synthesizeProviderSkill(pkg).content);
    expect(text).toContain("name: provider-x-no-def");
    expect(text).toContain("- **displayName**: NoDef");
    expect(text).not.toContain("- **authMode**:");
    expect(text).not.toContain("- **authorizedUris**:");
  });
});
