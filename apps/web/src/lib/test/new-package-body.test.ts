// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { checkSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { newPackageBody, type NewPackageInput } from "../new-package-body";

const input: NewPackageInput = {
  scope: "acme",
  email: "dev@acme.test",
  id: "word-count",
  displayName: " Word count ",
  description: " Counts words. ",
  prompt: "Count the words.",
  url: " https://example.com/mcp ",
};

describe("newPackageBody", () => {
  it("names an agent from the scope and carries its prompt as the content", () => {
    const body = newPackageBody("agent", input);
    expect(body.manifest).toMatchObject({
      type: "agent",
      name: "@acme/word-count",
      display_name: "Word count",
      description: "Counts words.",
      author: "dev@acme.test",
    });
    expect(body.content).toBe("Count the words.");
  });

  it("writes a SKILL.md the write gate accepts, whatever the description holds", () => {
    for (const description of ["Counts words.", 'Counts: words, # and "quotes"', "a\nb"]) {
      const body = newPackageBody("skill", { ...input, description });
      expect(body.manifest).toMatchObject({ type: "skill", name: "@acme/word-count" });
      expect(checkSkillMarkdown(body.content ?? "")).toBeNull();
    }
  });

  it("points an integration's remote source, and the auth allowlist that follows it, at the URL, manifest only", () => {
    const body = newPackageBody("integration", input);
    expect(body.manifest).toMatchObject({
      type: "integration",
      name: "@acme/word-count",
      source: { kind: "remote", remote: { url: "https://example.com/mcp" } },
      auths: { primary: { authorized_uris: ["https://example.com/**"] } },
    });
    // The API serialises `manifest.json` itself: the manifest travels once.
    expect(Object.keys(body)).toEqual(["manifest"]);
  });

  it("declares no integration for an agent unless one is given", () => {
    const body = newPackageBody("agent", input);
    expect(body.manifest).toMatchObject({ dependencies: {} });
    expect(JSON.stringify(body.manifest)).not.toContain("integrations");
  });

  it("starts an agent with an integration at any version, with no tool selection", () => {
    const body = newPackageBody("agent", { ...input, integrationId: "@appstrate/gmail" });
    const manifest = body.manifest as { dependencies: Record<string, unknown> };
    expect(manifest.dependencies.integrations).toEqual({ "@appstrate/gmail": "*" });
    expect(JSON.stringify(body.manifest)).not.toContain("integrations_configuration");
  });
});
