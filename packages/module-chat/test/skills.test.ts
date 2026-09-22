// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveChatSkills` — which skills a turn indexes, and in what order.
 *
 * The resolver is pure, so every rule below is asserted on inputs alone: the
 * three discovery modes, the total order the prompt cache depends on, the
 * pinned-wins tag, and the one case that becomes prose in the prompt (a pin
 * that does not resolve) versus the one that deliberately does not (a platform
 * default that does not resolve).
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SKILL_DISCOVERY,
  PLATFORM_DEFAULT_SKILLS,
  SKILL_DISCOVERY_MODES,
  resolveChatSkills,
  toSkillDiscovery,
  type ResolveChatSkillsInput,
  type SkillHint,
} from "../src/skills.ts";

const hint = (id: string, extra?: Partial<SkillHint>): SkillHint => ({
  package_id: id,
  display_name: id,
  description: "A skill.",
  version: "1.0.0",
  ...extra,
});

function resolve(over: Partial<ResolveChatSkillsInput> = {}) {
  return resolveChatSkills({
    discovery: DEFAULT_SKILL_DISCOVERY,
    pinned: [],
    defaults: [],
    requested: [],
    unresolved: [],
    catalogue: [],
    catalogueTruncated: false,
    ...over,
  });
}

describe("the platform default list", () => {
  it("names the three chat skills, sorted", () => {
    expect(PLATFORM_DEFAULT_SKILLS).toEqual([
      "@appstrate/connector-choice",
      "@appstrate/copilot",
      "@appstrate/web-search",
    ]);
    expect([...PLATFORM_DEFAULT_SKILLS].sort()).toEqual([...PLATFORM_DEFAULT_SKILLS]);
  });

  it("offers exactly three discovery modes, defaulting to auto", () => {
    expect([...SKILL_DISCOVERY_MODES]).toEqual(["auto", "on_demand", "manual"]);
    expect(DEFAULT_SKILL_DISCOVERY).toBe("auto");
  });
});

describe("toSkillDiscovery", () => {
  it("passes every known mode through unchanged", () => {
    for (const mode of SKILL_DISCOVERY_MODES) expect(toSkillDiscovery(mode)).toBe(mode);
  });

  /**
   * The narrowing point, and the ONLY one: `resolveChatSkills` takes a typed
   * `SkillDiscovery` and re-checks nothing. A stored value reaches the chat
   * through this function (`ensureSession` reads the column with it), so an
   * unknown one must land on the default here or nowhere.
   */
  it("degrades an unknown or absent stored value to the default", () => {
    for (const raw of ["nonsense", "", null, undefined, 3, {}])
      expect(toSkillDiscovery(raw)).toBe(DEFAULT_SKILL_DISCOVERY);
  });
});

describe("resolveChatSkills", () => {
  it("indexes defaults and pins, sorted by package id whatever order they arrive in", () => {
    const out = resolve({
      defaults: ["@a/zulu", "@a/alpha"],
      pinned: ["@a/mike"],
      requested: [hint("@a/mike"), hint("@a/zulu"), hint("@a/alpha")],
    });
    expect(out.indexed.map((s) => s.package_id)).toEqual(["@a/alpha", "@a/mike", "@a/zulu"]);
  });

  it("drops a requested hint nothing asked for, and de-duplicates the rest", () => {
    const out = resolve({
      defaults: ["@a/alpha"],
      // A stray hint (the server was asked for it by another turn's state) and
      // a duplicate must not both land in the index.
      requested: [hint("@a/alpha"), hint("@a/alpha"), hint("@a/stray")],
    });
    expect(out.indexed.map((s) => s.package_id)).toEqual(["@a/alpha"]);
  });

  it("tags origin, and a pin wins over a platform default", () => {
    const out = resolve({
      defaults: ["@a/alpha", "@a/both"],
      pinned: ["@a/both", "@a/mine"],
      requested: [hint("@a/alpha"), hint("@a/both"), hint("@a/mine")],
    });
    expect(out.indexed.map((s) => [s.package_id, s.origin])).toEqual([
      ["@a/alpha", "platform"],
      ["@a/both", "pinned"],
      ["@a/mine", "pinned"],
    ]);
  });

  it("auto: shows the catalogue minus what is already indexed, and keeps its truncation", () => {
    const out = resolve({
      discovery: "auto",
      defaults: ["@a/alpha"],
      requested: [hint("@a/alpha")],
      catalogue: [hint("@a/alpha"), hint("@a/other")],
      catalogueTruncated: true,
    });
    expect(out.catalogue.map((s) => s.package_id)).toEqual(["@a/other"]);
    expect(out.catalogueTruncated).toBe(true);
  });

  it("on_demand: indexes defaults and pins, and shows no catalogue at all", () => {
    const out = resolve({
      discovery: "on_demand",
      defaults: ["@a/alpha"],
      pinned: ["@a/mine"],
      requested: [hint("@a/alpha"), hint("@a/mine")],
      catalogue: [hint("@a/other")],
      catalogueTruncated: true,
    });
    expect(out.indexed.map((s) => s.package_id)).toEqual(["@a/alpha", "@a/mine"]);
    expect(out.catalogue).toEqual([]);
    // A truncation marker for a catalogue that is not rendered would be a lie.
    expect(out.catalogueTruncated).toBe(false);
  });

  it("manual: indexes the pins ONLY — not even the platform defaults", () => {
    const out = resolve({
      discovery: "manual",
      defaults: ["@a/alpha"],
      pinned: ["@a/mine"],
      requested: [hint("@a/alpha"), hint("@a/mine")],
      catalogue: [hint("@a/other")],
    });
    expect(out.indexed.map((s) => s.package_id)).toEqual(["@a/mine"]);
    expect(out.catalogue).toEqual([]);
  });

  it("notices an unresolved PIN and stays silent about an unresolved DEFAULT", () => {
    const out = resolve({
      defaults: ["@a/gone-default"],
      pinned: ["@a/gone-pin", "@a/here"],
      requested: [hint("@a/here")],
      unresolved: ["@a/gone-default", "@a/gone-pin"],
    });
    expect(out.indexed.map((s) => s.package_id)).toEqual(["@a/here"]);
    expect(out.notices).toHaveLength(1);
    expect(out.notices[0]).toContain("@a/gone-pin");
    expect(out.notices.join("\n")).not.toContain("@a/gone-default");
  });

  it("orders notices deterministically and de-duplicates the pin list", () => {
    const out = resolve({
      pinned: ["@a/zulu", "@a/alpha", "@a/zulu"],
      unresolved: ["@a/zulu", "@a/alpha"],
    });
    expect(out.notices).toHaveLength(2);
    expect(out.notices[0]).toContain("@a/alpha");
    expect(out.notices[1]).toContain("@a/zulu");
  });

  it("returns the same object shape for two calls with the same inputs", () => {
    const input: Partial<ResolveChatSkillsInput> = {
      defaults: ["@a/alpha"],
      pinned: ["@a/mine"],
      requested: [hint("@a/mine"), hint("@a/alpha")],
      catalogue: [hint("@a/other")],
    };
    expect(JSON.stringify(resolve(input))).toBe(JSON.stringify(resolve(input)));
  });
});
