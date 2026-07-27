// SPDX-License-Identifier: Apache-2.0

/**
 * Writers MUST NOT emit non-canonical camelCase keys.
 *
 * Umbrella regression test catching the whole class of writer-leak bugs (e.g. a
 * writer emitting `displayName` instead of `display_name`). Pins the canonical
 * contract so a future writer that accidentally re-introduces camelCase fails
 * CI before merge.
 *
 * Coverage:
 *  - `writeManifestIntegrations` round-trip (the canonical writer for the
 *    `dependencies.integrations.<id>` object form + the top-level
 *    `integrations` block per AFPS §4.1).
 *  - The package-create writer (`buildStoredManifest`, the pure core of
 *    `createOrgItem`) is covered in `apps/api/test/unit/build-stored-manifest.test.ts`
 *    — against the REAL function, in the package that can import it. A
 *    hand-copied simulation used to stand in for it here and silently drifted
 *    from production (it still rewrote `manifest.type`, which issue #987 made
 *    an error).
 *  - `metadataToManifestPatch` is covered by
 *    `apps/web/src/components/agent-editor/test/utils.test.ts` — already
 *    asserts `displayName: undefined` is emitted alongside canonical
 *    `display_name`.
 *
 * Banned non-canonical camelCase keys:
 *   displayName, schemaVersion, fileConstraints, uiHints, propertyOrder,
 *   maxSize, iconUrl, providersConfiguration, runtimeTools
 */

import { describe, it, expect } from "bun:test";
import { parseManifestIntegrations, writeManifestIntegrations } from "../src/dependencies.ts";

// ─────────────────────────────────────────────
// Banned-key audit
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

function findBannedKeysDeep(value: unknown, basePath = "$"): Violation[] {
  const out: Violation[] = [];
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...findBannedKeysDeep(v, `${basePath}[${i}]`)));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = `${basePath}.${k}`;
    if ((BANNED_CAMEL_KEYS as readonly string[]).includes(k)) {
      out.push({ path, key: k });
    }
    out.push(...findBannedKeysDeep(v, path));
  }
  return out;
}

// ─────────────────────────────────────────────
// writeManifestIntegrations round-trip
// ─────────────────────────────────────────────

describe("writeManifestIntegrations emits canonical AFPS §4.1 keys only", () => {
  it("round-trips tools + scopes + auth_key through canonical keys only", () => {
    const m: Record<string, unknown> = {};
    writeManifestIntegrations(m, [
      {
        id: "@acme/github-mcp",
        version: "^1.0.0",
        tools: ["list_issues"],
        scopes: ["repo"],
        auth_key: "pat",
      },
    ]);
    const parsed = parseManifestIntegrations(m);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "@acme/github-mcp",
      version: "^1.0.0",
      tools: ["list_issues"],
      scopes: ["repo"],
      auth_key: "pat",
    });
    const violations = findBannedKeysDeep(m);
    expect(violations).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// Deep-walk sanity (helper itself works)
// ─────────────────────────────────────────────

describe("banned-key walker (test infrastructure)", () => {
  it("flags camelCase keys at any depth", () => {
    const v = findBannedKeysDeep({
      version: "1.0.0",
      input: {
        fileConstraints: { foo: { maxSize: 100 } },
        schema: { properties: { x: { uiHints: { placeholder: "x" } } } },
      },
    });
    const keys = v.map((x) => x.key).sort();
    expect(keys).toContain("fileConstraints");
    expect(keys).toContain("maxSize");
    expect(keys).toContain("uiHints");
  });

  it("accepts canonical snake_case manifest", () => {
    const v = findBannedKeysDeep({
      name: "@x/y",
      version: "1.0.0",
      display_name: "Y",
      schema_version: "0.1",
      icon_url: "https://x.example/icon.png",
      input: {
        schema: { properties: { x: { type: "string" } } },
        file_constraints: { foo: { max_size: 100 } },
        ui_hints: { x: { placeholder: "x" } },
        property_order: ["x"],
      },
      dependencies: {
        skills: { "@x/s": "^1.0.0" },
        mcp_servers: { "@x/m": "^1.0.0" },
        integrations: { "@x/i": "^1.0.0" },
      },
      runtime_tools: ["output"],
    });
    expect(v).toEqual([]);
  });
});
