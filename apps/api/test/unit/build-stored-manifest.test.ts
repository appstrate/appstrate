// SPDX-License-Identifier: Apache-2.0

/**
 * `buildStoredManifest` — the pure stamping step every package create goes
 * through (`createOrgItem` → `packages.draft_manifest`, then snapshotted
 * verbatim into the immutable `package_versions.manifest` row).
 *
 * Two contracts live here:
 *
 *  1. **The `type` invariant (issue #987)**. The stamping used to REWRITE
 *     `manifest.type` to the route's package type, after `validateManifest`
 *     had already dispatched on the manifest's own root `type`. A manifest
 *     valid for one type therefore became a stored manifest no AFPS schema
 *     accepts. `buildStoredManifest` now throws instead — a plain `Error`,
 *     because over HTTP the routes gate the author manifest
 *     (`validateManifestForRoute`) and `forkPackage` normalizes its published
 *     snapshot before calling, so reaching this is a broken invariant, never
 *     client input.
 *
 *  2. **The canonical-casing contract** (`display_name`, never `displayName`).
 *     These assertions used to live in `packages/core/test/writers-canonical.test.ts`
 *     against a hand-copied `simulateCreateOrgItem`; that copy drifted the
 *     moment production stopped rewriting `type`. They run against the real
 *     function here — the API package is the one that can import it.
 */

import { describe, it, expect } from "bun:test";
import { buildStoredManifest } from "../../src/services/package-items/manifest.ts";
import { CONFIG_BY_TYPE } from "../../src/services/package-items/config.ts";
import { AFPS_SCHEMA_URLS, type PackageType } from "@appstrate/core/validation";

const TYPES = ["agent", "skill", "mcp-server", "integration"] as const;

/** Minimal manifest of `type`, valid enough for a pure stamping test. */
function manifestOf(type: PackageType, overrides: Record<string, unknown> = {}) {
  return {
    name: "@acme/test",
    version: "1.0.0",
    type,
    schema_version: "0.1",
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// The `type` invariant (issue #987)
// ─────────────────────────────────────────────

describe("buildStoredManifest — manifest/config type agreement", () => {
  it("throws when the manifest type disagrees with the package type", () => {
    expect(() =>
      buildStoredManifest(manifestOf("skill"), CONFIG_BY_TYPE["mcp-server"], {
        id: "@acme/test",
      }),
    ).toThrow(/expected "mcp-server", received "skill"/);
  });

  it("throws when the manifest carries no type at all", () => {
    const { type: _dropped, ...typeless } = manifestOf("agent");
    expect(() => buildStoredManifest(typeless, CONFIG_BY_TYPE.agent, { id: "@acme/test" })).toThrow(
      /expected "agent", received "undefined"/,
    );
  });

  it("names the package id in the error, so the broken row is identifiable", () => {
    expect(() =>
      buildStoredManifest(manifestOf("agent"), CONFIG_BY_TYPE.skill, { id: "@acme/mislabelled" }),
    ).toThrow(/@acme\/mislabelled/);
  });

  for (const type of TYPES) {
    it(`accepts a matching ${type} manifest and preserves its type verbatim`, () => {
      const stored = buildStoredManifest(manifestOf(type), CONFIG_BY_TYPE[type], {
        id: "@acme/test",
      });
      expect(stored.type).toBe(type);
    });
  }
});

// ─────────────────────────────────────────────
// Stamping
// ─────────────────────────────────────────────

describe("buildStoredManifest — stamping", () => {
  for (const type of TYPES) {
    it(`stamps the ${type} $schema pointer from the package config`, () => {
      const stored = buildStoredManifest(manifestOf(type), CONFIG_BY_TYPE[type], {
        id: "@acme/test",
      });
      expect(stored.$schema).toBe(AFPS_SCHEMA_URLS[type]);
    });
  }

  it("overwrites an author-supplied $schema (the pointer is platform-owned)", () => {
    const stored = buildStoredManifest(
      manifestOf("agent", { $schema: "https://evil.example/agent.json" }),
      CONFIG_BY_TYPE.agent,
      { id: "@acme/test" },
    );
    expect(stored.$schema).toBe(AFPS_SCHEMA_URLS.agent);
  });

  it("defaults a missing name to the package id", () => {
    const { name: _dropped, ...nameless } = manifestOf("agent");
    const stored = buildStoredManifest(nameless, CONFIG_BY_TYPE.agent, { id: "@acme/defaulted" });
    expect(stored.name).toBe("@acme/defaulted");
  });

  it("keeps the manifest's own name when it has one", () => {
    const stored = buildStoredManifest(
      manifestOf("agent", { name: "@acme/authored" }),
      CONFIG_BY_TYPE.agent,
      { id: "@acme/authored" },
    );
    expect(stored.name).toBe("@acme/authored");
  });

  it("writes item.name / item.description as display_name / description", () => {
    const stored = buildStoredManifest(manifestOf("skill"), CONFIG_BY_TYPE.skill, {
      id: "@acme/test",
      name: "Test Item",
      description: "A test item",
    });
    expect(stored.display_name).toBe("Test Item");
    expect(stored.description).toBe("A test item");
  });

  it("leaves the manifest's own display_name / description alone when item has none", () => {
    const stored = buildStoredManifest(
      manifestOf("skill", { display_name: "Author Label", description: "Author blurb" }),
      CONFIG_BY_TYPE.skill,
      { id: "@acme/test" },
    );
    expect(stored.display_name).toBe("Author Label");
    expect(stored.description).toBe("Author blurb");
  });

  it("does NOT mutate its input — the caller's manifest is reused downstream", () => {
    const input = manifestOf("agent", { display_name: "Before" }) as Record<string, unknown>;
    const snapshot = structuredClone(input);
    buildStoredManifest(input, CONFIG_BY_TYPE.agent, {
      id: "@acme/other",
      name: "After",
      description: "Added",
    });
    expect(input).toEqual(snapshot);
  });
});

// ─────────────────────────────────────────────
// Canonical casing — moved off the core copy
// ─────────────────────────────────────────────

const BANNED_CAMEL_KEYS = [
  "displayName",
  "schemaVersion",
  "fileConstraints",
  "uiHints",
  "propertyOrder",
  "maxSize",
  "iconUrl",
  "providersConfiguration",
  "runtimeTools",
] as const;

interface Violation {
  path: string;
  key: string;
}

/**
 * Deep walk for non-canonical camelCase keys. Mirrors the walker in
 * `packages/core/test/writers-canonical.test.ts` (which still guards
 * `writeManifestIntegrations`); duplicated rather than shared because that is a
 * different package's test tree.
 */
function findBannedKeysDeep(value: unknown, basePath = "$"): Violation[] {
  const out: Violation[] = [];
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...findBannedKeysDeep(v, `${basePath}[${i}]`)));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = `${basePath}.${k}`;
    if ((BANNED_CAMEL_KEYS as readonly string[]).includes(k)) out.push({ path, key: k });
    out.push(...findBannedKeysDeep(v, path));
  }
  return out;
}

describe("buildStoredManifest never emits non-canonical camelCase keys", () => {
  for (const type of TYPES) {
    it(`stores a ${type} manifest with canonical snake_case keys only`, () => {
      const stored = buildStoredManifest(manifestOf(type), CONFIG_BY_TYPE[type], {
        id: "@acme/test",
        name: "Test Item",
        description: "A test item",
      });
      // display_name MUST be present, displayName MUST NOT.
      expect(stored.display_name).toBe("Test Item");
      expect(stored).not.toHaveProperty("displayName");
      expect(findBannedKeysDeep(stored)).toEqual([]);
    });

    it(`stores a ${type} manifest without introducing camelCase over snake_case input`, () => {
      const stored = buildStoredManifest(
        manifestOf(type, {
          display_name: "Existing Canonical",
          icon_url: "https://example.com/icon.png",
          input: {
            schema: { properties: { x: { type: "string" } } },
            file_constraints: { foo: { max_size: 100 } },
            ui_hints: { x: { placeholder: "x" } },
            property_order: ["x"],
          },
        }),
        CONFIG_BY_TYPE[type],
        { id: "@acme/test", name: "Test", description: "Desc" },
      );
      expect(findBannedKeysDeep(stored)).toEqual([]);
    });
  }

  it("flags a camelCase leak at any depth (walker sanity)", () => {
    const violations = findBannedKeysDeep({
      input: { fileConstraints: { foo: { maxSize: 100 } } },
    });
    expect(violations.map((v) => v.key).sort()).toEqual(["fileConstraints", "maxSize"]);
  });
});
