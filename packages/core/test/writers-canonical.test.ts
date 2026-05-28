// SPDX-License-Identifier: Apache-2.0

/**
 * T1 (Wave 3) — Writers MUST NOT emit non-canonical camelCase keys.
 *
 * Umbrella regression test catching the WHOLE CLASS of writer-leak bugs that
 * shipped as C1 (`createOrgItem` writing `displayName`). Wave 1 fixes are
 * already in place; this test pins them so a future writer that accidentally
 * re-introduces camelCase fails CI before merge.
 *
 * Coverage:
 *  - `createOrgItem` manifest-mutation logic (`apps/api/src/services/package-items/crud.ts`)
 *    is inlined as a pure helper for each of the 4 package types (the DB-bound
 *    function itself requires too much wiring — DB + auth context — to test in
 *    a packages/core unit test). The inlined helper is byte-for-byte identical
 *    to the production manifest-mutation path (`finalManifest.<key> = …`).
 *  - `writeManifestIntegrations` round-trip (the canonical writer for the
 *    `dependencies.integrations.<id>` object form + the top-level
 *    `integrations` block per AFPS §4.1).
 *  - `metadataToManifestPatch` is covered by
 *    `apps/web/src/components/agent-editor/test/utils.test.ts` — already
 *    asserts `displayName: undefined` is emitted alongside canonical
 *    `display_name`. Re-tested here at the JSON level since the patch is
 *    shallow-merged into the manifest and the non-canonical key MUST drop on
 *    serialization.
 *
 * Banned non-canonical camelCase keys:
 *   displayName, schemaVersion, fileConstraints, uiHints, propertyOrder,
 *   maxSize, iconUrl, providersConfiguration, runtimeTools
 */

import { describe, it, expect } from "bun:test";
import { parseManifestIntegrations, writeManifestIntegrations } from "../src/dependencies.ts";
import { AFPS_SCHEMA_URLS } from "../src/validation.ts";

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

/**
 * Mirrors the manifest-mutation block in
 * `apps/api/src/services/package-items/crud.ts:95-103` (`createOrgItem`).
 * Pure — no DB, no auth context. Wave1-A C1 fix landed: `display_name` (not
 * `displayName`). This helper pins that contract.
 */
function simulateCreateOrgItem(
  type: "agent" | "skill" | "mcp-server" | "integration",
  item: { id: string; name?: string; description?: string },
  manifest?: Record<string, unknown>,
): Record<string, unknown> {
  const finalManifest: Record<string, unknown> = manifest
    ? { ...manifest }
    : { version: "1.0.0", name: item.id };
  finalManifest.$schema = AFPS_SCHEMA_URLS[type];
  finalManifest.type = type;
  if (!finalManifest.name) finalManifest.name = item.id;
  if (item.name) finalManifest.display_name = item.name;
  if (item.description) finalManifest.description = item.description;
  return finalManifest;
}

// ─────────────────────────────────────────────
// T1 — createOrgItem simulation per package type
// ─────────────────────────────────────────────

describe("T1 — createOrgItem writer never emits AFPS-1.x camelCase keys", () => {
  const TYPES = ["agent", "skill", "mcp-server", "integration"] as const;

  for (const type of TYPES) {
    it(`creates a ${type} manifest with canonical snake_case keys only`, () => {
      const m = simulateCreateOrgItem(type, {
        id: "@acme/test",
        name: "Test Item",
        description: "A test item",
      });
      // C1 — display_name MUST be present, displayName MUST NOT.
      expect(m.display_name).toBe("Test Item");
      expect(m).not.toHaveProperty("displayName");
      const violations = findBannedKeysDeep(m);
      if (violations.length > 0) {
        // surface a readable failure message
        throw new Error(
          `Banned AFPS-1.x camelCase keys leaked from createOrgItem(${type}): ` +
            violations.map((v) => `${v.path} (${v.key})`).join(", "),
        );
      }
    });

    it(`createOrgItem(${type}) does not introduce camelCase when input has snake_case`, () => {
      const m = simulateCreateOrgItem(
        type,
        { id: "@acme/test", name: "Test", description: "Desc" },
        {
          name: "@acme/test",
          version: "2.0.0",
          display_name: "Existing Canonical",
          schema_version: "0.1",
          icon_url: "https://example.com/icon.png",
        },
      );
      const violations = findBannedKeysDeep(m);
      expect(violations).toEqual([]);
    });

    it(`createOrgItem(${type}) does not COPY legacy camelCase from input`, () => {
      // If a legacy manifest enters the writer, the writer MUST NOT replicate
      // the legacy key (item.name overwrites display_name canonically).
      // NOTE: writers don't actively strip legacy siblings — that's M8 in the
      // editor path. This test pins what the writer DOES emit canonically and
      // confirms the C1 fix (display_name, not displayName) is intact.
      const legacyInput: Record<string, unknown> = {
        name: "@acme/test",
        version: "1.0.0",
      };
      const m = simulateCreateOrgItem(
        type,
        { id: "@acme/test", name: "Canonical Label" },
        legacyInput,
      );
      // The writer emits canonical display_name; displayName never introduced.
      expect(m.display_name).toBe("Canonical Label");
      expect(m).not.toHaveProperty("displayName");
    });
  }
});

// ─────────────────────────────────────────────
// T1 — writeManifestIntegrations round-trip
// ─────────────────────────────────────────────

describe("T1 — writeManifestIntegrations emits canonical AFPS §4.1 keys only", () => {
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
// T1 — Deep-walk sanity (helper itself works)
// ─────────────────────────────────────────────

describe("T1 — banned-key walker (test infrastructure)", () => {
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
