// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseSkillUri, parseSkillUriPackage, skillFileUri } from "../src/skill-uri.ts";

const SPACE = "spc_1";

describe("skill:// URIs", () => {
  it("round-trips the published and the draft form, the name before SKILL.md", () => {
    const published = {
      spaceId: SPACE,
      packageId: "@acme/tone-kit",
      name: "tone",
      path: "SKILL.md",
    };
    const uri = skillFileUri({ ...published, definition: "published" });
    expect(uri).toBe("skill://spc_1/acme/tone-kit/tone/SKILL.md");
    expect(parseSkillUri(uri)).toEqual({ ...published, definition: "published" });
    const draft = skillFileUri({ ...published, definition: "draft", path: "refs/a b.md" });
    expect(draft).toBe("skill://spc_1/acme/tone-kit@draft/tone/refs/a%20b.md");
    expect(parseSkillUri(draft)).toEqual({
      ...published,
      definition: "draft",
      path: "refs/a b.md",
    });
  });

  it("reads a published skill named `draft` as published", () => {
    expect(parseSkillUri("skill://spc_1/acme/kit/draft/x/SKILL.md")).toMatchObject({
      definition: "published",
      name: "draft",
      path: "x/SKILL.md",
    });
  });

  it("refuses other schemes, missing segments, traversal, invalid names and non-canonical escapes", () => {
    for (const uri of [
      "appfile://file_1",
      "skill://spc_1/acme/kit/SKILL.md",
      "skill://spc_1/acme/kit/tone/../x",
      "skill://spc_1/acme/kit/tone/%2e%2e/x",
      "skill://spc_1/acme/kit/Tone/SKILL.md",
      "skill://spc_1/acme/kit/tone//SKILL.md",
      "skill://spc_1/acme/kit/tone/refs%2FSKILL.md",
      "skill://spc_1/acme/kit/tone/refs/a%2fb.md",
      "skill://spc_1/acme/kit/tone/%53KILL.md",
      "skill://spc_1/acme/kit/tone/refs/",
      "skill://spc_1/acme/kit/tone/%2Fetc/passwd",
    ]) {
      expect(parseSkillUri(uri)).toBeNull();
    }
  });

  it("reads the package of a URI from its package segments alone", () => {
    expect(parseSkillUriPackage("skill://spc_1/acme/tone-kit/Not_Valid/../x")).toEqual({
      packageId: "@acme/tone-kit",
      definition: "published",
    });
    expect(parseSkillUriPackage("skill://spc_1/acme/tone-kit@draft/tone/SKILL.md")).toEqual({
      packageId: "@acme/tone-kit",
      definition: "draft",
    });
    for (const uri of [
      "skill://spc_1/acme",
      "skill://spc_1//tone-kit/x",
      "file://spc_1/acme/x/y",
    ]) {
      expect(parseSkillUriPackage(uri)).toBeNull();
    }
  });
});
