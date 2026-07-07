// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `unlisted` package visibility helper (issue #848) and the
 * assistant-skills index formatter. Pure logic — the listing-surface filtering
 * itself is covered by `test/integration/routes/unlisted-packages.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { isUnlisted, VISIBILITY_META_NAMESPACE } from "../../src/lib/package-visibility.ts";
import { formatAssistantSkillsSection } from "../../src/services/assistant-skills.ts";

const unlistedMeta = { [VISIBILITY_META_NAMESPACE]: { level: "unlisted" } };

describe("isUnlisted", () => {
  it("detects the unlisted level under the vendor namespace", () => {
    expect(isUnlisted({ name: "@appstrate/copilot", _meta: unlistedMeta })).toBe(true);
  });

  it("defaults to listed when _meta or the namespace is absent", () => {
    expect(isUnlisted({ name: "@acme/skill" })).toBe(false);
    expect(isUnlisted({ name: "@acme/skill", _meta: {} })).toBe(false);
    expect(isUnlisted({ name: "@acme/skill", _meta: { "dev.acme/other": { x: 1 } } })).toBe(false);
  });

  it("defaults to listed for any other level or malformed shape", () => {
    expect(isUnlisted({ _meta: { [VISIBILITY_META_NAMESPACE]: { level: "public" } } })).toBe(false);
    expect(isUnlisted({ _meta: { [VISIBILITY_META_NAMESPACE]: "unlisted" } })).toBe(false);
    expect(isUnlisted({ _meta: { [VISIBILITY_META_NAMESPACE]: { level: 42 } } })).toBe(false);
    expect(isUnlisted({ _meta: null })).toBe(false);
  });

  it("tolerates null/undefined manifests", () => {
    expect(isUnlisted(null)).toBe(false);
    expect(isUnlisted(undefined)).toBe(false);
  });
});

describe("formatAssistantSkillsSection", () => {
  it("returns an empty string when there is nothing to index", () => {
    expect(formatAssistantSkillsSection([])).toBe("");
  });

  it("renders the heading, the getSkill load instruction, and one line per skill", () => {
    const section = formatAssistantSkillsSection([
      {
        package_id: "@appstrate/copilot",
        display_name: "Copilote",
        description: "Guide the user to a working agent.",
      },
      {
        package_id: "@appstrate/web-search",
        display_name: "@appstrate/web-search",
        description: "Search the web via an inline run.",
      },
    ]);
    expect(section).toStartWith("## Assistant skills");
    expect(section).toContain('`operation_id: "getSkill"`');
    expect(section).toContain("- `@appstrate/copilot` — Copilote: Guide the user");
    // A display_name equal to the id is not repeated.
    expect(section).toContain("- `@appstrate/web-search` — Search the web");
  });
});
