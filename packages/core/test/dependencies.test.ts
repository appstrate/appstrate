// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  extractDependencies,
  detectCycle,
  parseManifestIntegrations,
  writeManifestIntegrations,
} from "../src/dependencies.ts";
import type { DepEntry } from "../src/dependencies.ts";

describe("extractDependencies", () => {
  it("manifest with skills and integrations", () => {
    const manifest = {
      dependencies: {
        skills: { "@acme/skill-a": "^1.0.0", "@acme/skill-b": "~2.0.0" },
        integrations: { "@acme/svc-c": ">=1.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(3);

    const skillA = deps.find((d) => d.depName === "skill-a");
    expect(skillA).toBeDefined();
    expect(skillA!.depScope).toBe("@acme");
    expect(skillA!.depType).toBe("skill");
    expect(skillA!.versionRange).toBe("^1.0.0");

    const svcC = deps.find((d) => d.depName === "svc-c");
    expect(svcC).toBeDefined();
    expect(svcC!.depType).toBe("integration");
  });

  it("manifest without dependencies", () => {
    const deps = extractDependencies({});
    expect(deps).toHaveLength(0);
  });

  it("manifest with empty dependencies", () => {
    const deps = extractDependencies({ dependencies: {} });
    expect(deps).toHaveLength(0);
  });

  it("scoped names are parsed correctly", () => {
    const manifest = {
      dependencies: {
        skills: { "@my-org/cool-skill": "^1.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps[0]!.depScope).toBe("@my-org");
    expect(deps[0]!.depName).toBe("cool-skill");
  });

  it("manifest with integrations", () => {
    const manifest = {
      dependencies: {
        integrations: { "@acme/slack": "^1.0.0", "@acme/github": "~2.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(2);

    const slack = deps.find((d) => d.depName === "slack");
    expect(slack).toBeDefined();
    expect(slack!.depScope).toBe("@acme");
    expect(slack!.depType).toBe("integration");
    expect(slack!.versionRange).toBe("^1.0.0");
  });

  it("manifest with both skills and integrations", () => {
    const manifest = {
      dependencies: {
        skills: { "@acme/skill-a": "^1.0.0" },
        integrations: { "@acme/gmail-mcp": "^1.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(2);
    expect(deps.find((d) => d.depType === "skill")).toBeDefined();
    expect(deps.find((d) => d.depType === "integration")).toBeDefined();
  });

  it("manifest with mcp_servers — AFPS 2.0 first-class dep map", () => {
    const manifest = {
      dependencies: {
        mcp_servers: { "@acme/gmail-server": "^1.0.0", "@acme/github-server": "~2.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(2);

    const gmail = deps.find((d) => d.depName === "gmail-server");
    expect(gmail).toBeDefined();
    expect(gmail!.depScope).toBe("@acme");
    expect(gmail!.depType).toBe("mcp-server");
    expect(gmail!.versionRange).toBe("^1.0.0");
  });

  it("manifest with all three dep categories (skills + mcp_servers + integrations)", () => {
    const manifest = {
      dependencies: {
        skills: { "@acme/skill-a": "^1.0.0" },
        mcp_servers: { "@acme/gmail-server": "^1.0.0" },
        integrations: { "@acme/gmail-mcp": "^1.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(3);
    expect(deps.find((d) => d.depType === "skill")).toBeDefined();
    expect(deps.find((d) => d.depType === "mcp-server")).toBeDefined();
    expect(deps.find((d) => d.depType === "integration")).toBeDefined();
  });

  it("throws on invalid scoped name in mcp_servers", () => {
    const manifest = {
      dependencies: { mcp_servers: { "no-scope": "^1.0.0" } },
    };
    expect(() => extractDependencies(manifest)).toThrow("Invalid scoped package name: no-scope");
  });

  it("accepts mcp_servers value in object form (§4.1) and extracts the version", () => {
    const manifest = {
      dependencies: { mcp_servers: { "@acme/srv": { version: "^1.0.0" } } },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.depType).toBe("mcp-server");
    expect(deps[0]!.versionRange).toBe("^1.0.0");
  });

  it("accepts skill value in object form (§4.1) and extracts the version", () => {
    const manifest = {
      dependencies: { skills: { "@acme/skill": { version: "^1.0.0" } } },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.depType).toBe("skill");
    expect(deps[0]!.versionRange).toBe("^1.0.0");
  });

  it("accepts integration value in object form (§4.1) with scopes + auth_key extras", () => {
    const manifest = {
      dependencies: {
        integrations: {
          "@acme/gmail-mcp": {
            version: "^1.0.0",
            scopes: ["gmail.readonly"],
            auth_key: "oauth",
          },
        },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.depType).toBe("integration");
    expect(deps[0]!.versionRange).toBe("^1.0.0");
  });

  it("throws when dependency value is neither string nor object-with-version", () => {
    const manifest = {
      dependencies: { skills: { "@acme/skill": 42 as unknown as string } },
    };
    expect(() => extractDependencies(manifest)).toThrow(/expected string or/);
  });

  it("throws on invalid scoped package name", () => {
    const manifest = {
      dependencies: {
        skills: { "invalid-name": "^1.0.0" },
      },
    };
    expect(() => extractDependencies(manifest)).toThrow(
      "Invalid scoped package name: invalid-name",
    );
  });

  it("manifest with integrations as bare version string (legacy)", () => {
    const manifest = {
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.depType).toBe("integration");
    expect(deps[0]!.versionRange).toBe("^1.0.0");
  });

  it("accepts integration dependency value in object form (§4.1)", () => {
    const manifest = {
      dependencies: {
        integrations: { "@acme/gmail-mcp": { version: "^1.0.0" } },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.versionRange).toBe("^1.0.0");
  });

  // H5 — invalid semver range rejected upstream at extract time.
  it("throws on invalid semver range (string form)", () => {
    const manifest = {
      dependencies: { skills: { "@acme/skill": "not-a-range" } },
    };
    expect(() => extractDependencies(manifest)).toThrow(/Invalid semver range/);
  });

  it("throws on invalid semver range (object form)", () => {
    const manifest = {
      dependencies: {
        integrations: { "@acme/x": { version: "definitely-not-a-range" } },
      },
    };
    expect(() => extractDependencies(manifest)).toThrow(/Invalid semver range/);
  });

  it("accepts standard semver range forms", () => {
    // Sanity guard that the H5 validator doesn't over-reject (caret, tilde,
    // range, wildcard, exact, and the npm-style "*" are all valid).
    const manifest = {
      dependencies: {
        skills: {
          "@acme/a": "^1.0.0",
          "@acme/b": "~1.2.3",
          "@acme/c": ">=1.0.0 <2.0.0",
          "@acme/d": "1.x",
          "@acme/e": "1.0.0",
          "@acme/f": "*",
        },
      },
    };
    expect(() => extractDependencies(manifest)).not.toThrow();
  });

  // M7 — AFPS 1.x→2.0 read fallback (Appendix D).
  it("projects 1.x dependencies.providers into integrations", () => {
    const manifest = {
      dependencies: {
        providers: { "@acme/gmail": "^1.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.depType).toBe("integration");
    expect(deps[0]!.depScope).toBe("@acme");
    expect(deps[0]!.depName).toBe("gmail");
  });

  it("projects 1.x dependencies.tools into mcp_servers", () => {
    const manifest = {
      dependencies: {
        tools: { "@acme/git-tool": "^2.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.depType).toBe("mcp-server");
  });

  it("canonical integrations win over 1.x providers projection on collision", () => {
    const manifest = {
      dependencies: {
        integrations: { "@acme/gmail": "^2.0.0" },
        providers: { "@acme/gmail": "^1.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.versionRange).toBe("^2.0.0");
  });

  it("canonical mcp_servers win over 1.x tools projection on collision", () => {
    const manifest = {
      dependencies: {
        mcp_servers: { "@acme/srv": "^2.0.0" },
        tools: { "@acme/srv": "^1.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.versionRange).toBe("^2.0.0");
  });
});

describe("parseManifestIntegrations", () => {
  it("returns empty list for manifest without integrations", () => {
    expect(parseManifestIntegrations({})).toEqual([]);
    expect(parseManifestIntegrations({ dependencies: {} })).toEqual([]);
  });

  it("returns { tools: undefined } when only the dep version is declared", () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
    });
    expect(out).toEqual([
      { id: "@acme/gmail-mcp", version: "^1.0.0", tools: undefined, scopes: undefined },
    ]);
  });

  it("merges tools/scopes from the top-level `integrations` block", () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
      integrations: {
        "@acme/gmail-mcp": {
          tools: ["list_messages", "get_message"],
          scopes: ["s1", "s2"],
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("@acme/gmail-mcp");
    expect(out[0]!.tools).toEqual(["list_messages", "get_message"]);
    expect(out[0]!.scopes).toEqual(["s1", "s2"]);
  });

  it("accepts dep entries in object form (§4.1) and surfaces inline scopes/auth_key", () => {
    const out = parseManifestIntegrations({
      dependencies: {
        integrations: {
          "@acme/ok": "^1.0.0",
          "@acme/rich": {
            version: "^1.0.0",
            scopes: ["s1"],
            auth_key: "oauth",
          },
        },
      },
    });
    expect(out).toHaveLength(2);
    const rich = out.find((e) => e.id === "@acme/rich");
    expect(rich!.version).toBe("^1.0.0");
    expect(rich!.scopes).toEqual(["s1"]);
  });

  it("merges deprecated `integrations_configuration` alias (§4.4)", () => {
    // Per §4.4, the deprecated alias is still accepted; consumers MUST
    // accept it and merge into the dep entry.
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
      integrations_configuration: {
        "@acme/gmail-mcp": {
          tools: ["list_messages"],
          scopes: ["gmail.readonly"],
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.tools).toEqual(["list_messages"]);
    expect(out[0]!.scopes).toEqual(["gmail.readonly"]);
  });

  it("canonical dep-entry inline form wins over deprecated alias on conflict (§4.4)", () => {
    const out = parseManifestIntegrations({
      dependencies: {
        integrations: {
          "@acme/gmail-mcp": {
            version: "^1.0.0",
            scopes: ["canonical"],
          },
        },
      },
      integrations_configuration: {
        "@acme/gmail-mcp": { scopes: ["deprecated-alias"] },
      },
    });
    expect(out[0]!.scopes).toEqual(["canonical"]);
  });

  it("falls back to legacy top-level `integrations` block (back-compat read)", () => {
    // Manifests saved before AFPS 2.0.2 may still carry an Appstrate-invented
    // top-level `integrations` block. Read it for back-compat.
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
      integrations: {
        "@acme/gmail-mcp": { tools: ["legacy_tool"] },
      },
    });
    expect(out[0]!.tools).toEqual(["legacy_tool"]);
  });

  it("canonical wins over legacy top-level on conflict", () => {
    const out = parseManifestIntegrations({
      dependencies: {
        integrations: {
          "@acme/gmail-mcp": { version: "^1.0.0", tools: ["canonical"] },
        },
      },
      integrations: {
        "@acme/gmail-mcp": { tools: ["legacy"] },
      },
    });
    expect(out[0]!.tools).toEqual(["canonical"]);
  });

  it("filters non-string entries inside tools/scopes arrays", () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
      integrations: {
        "@acme/gmail-mcp": {
          tools: ["good", 42, null, "another"] as unknown as string[],
          scopes: ["s1", false, "s2"] as unknown as string[],
        },
      },
    });
    expect(out[0]!.tools).toEqual(["good", "another"]);
    expect(out[0]!.scopes).toEqual(["s1", "s2"]);
  });

  it("ignores a top-level `integrations` entry without a matching dep", () => {
    // The dep table is the canonical "is this integration declared" gate.
    // Selection blocks without a matching dep are silently dropped.
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
      integrations: {
        "@acme/gmail-mcp": { tools: ["a"] },
        "@acme/orphan": { tools: ["x"] },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("@acme/gmail-mcp");
  });
});

describe("writeManifestIntegrations", () => {
  it("emits canonical inline object form (§4.1) with scopes + tools, no top-level block", () => {
    const m: Record<string, unknown> = {};
    writeManifestIntegrations(m, [
      {
        id: "@acme/gmail-mcp",
        version: "^1.0.0",
        scopes: ["gmail.readonly"],
        tools: ["list_messages"],
      },
    ]);
    expect(m.dependencies).toEqual({
      integrations: {
        "@acme/gmail-mcp": {
          version: "^1.0.0",
          scopes: ["gmail.readonly"],
          tools: ["list_messages"],
        },
      },
    });
    // Must NOT emit the Appstrate-invented top-level block or the deprecated alias.
    expect(m.integrations).toBeUndefined();
    expect(m.integrations_configuration).toBeUndefined();
  });

  it("collapses entries with no scopes/tools to a bare semver string", () => {
    const m: Record<string, unknown> = {};
    writeManifestIntegrations(m, [{ id: "@acme/gmail-mcp", version: "^1.0.0" }]);
    expect(m.dependencies).toEqual({
      integrations: { "@acme/gmail-mcp": "^1.0.0" },
    });
  });

  it("round-trips through parseManifestIntegrations", () => {
    const m: Record<string, unknown> = {};
    const entries = [
      {
        id: "@acme/gmail-mcp",
        version: "^1.0.0",
        scopes: ["gmail.readonly"],
        tools: ["list_messages"],
      },
      { id: "@acme/slack", version: "^2.0.0" },
    ];
    writeManifestIntegrations(m, entries);
    const parsed = parseManifestIntegrations(m);
    expect(parsed).toHaveLength(2);
    const gmail = parsed.find((e) => e.id === "@acme/gmail-mcp");
    expect(gmail!.version).toBe("^1.0.0");
    expect(gmail!.scopes).toEqual(["gmail.readonly"]);
    expect(gmail!.tools).toEqual(["list_messages"]);
    const slack = parsed.find((e) => e.id === "@acme/slack");
    expect(slack!.version).toBe("^2.0.0");
    expect(slack!.scopes).toBeUndefined();
    expect(slack!.tools).toBeUndefined();
  });

  it("drops the legacy top-level `integrations` block + deprecated alias on write", () => {
    const m: Record<string, unknown> = {
      integrations: { "@acme/old": { tools: ["x"] } },
      integrations_configuration: { "@acme/old": { scopes: ["y"] } },
    };
    writeManifestIntegrations(m, [{ id: "@acme/gmail-mcp", version: "^1.0.0" }]);
    expect(m.integrations).toBeUndefined();
    expect(m.integrations_configuration).toBeUndefined();
  });

  it("empty entries clear `dependencies.integrations`", () => {
    const m: Record<string, unknown> = {
      dependencies: { integrations: { "@acme/old": "^1.0.0" } },
    };
    writeManifestIntegrations(m, []);
    const deps = m.dependencies as Record<string, unknown>;
    expect(deps.integrations).toBeUndefined();
  });

  // AFPS 1.x back-compat — removal tracked by AFPS_1X_READ_FALLBACK_REMOVAL
  // (see `packages/core/src/back-compat.ts`). These tests pin the contract:
  // read pre-2.0 camelCase aliases, write AFPS 2.0 canonical snake_case.
  it("reads `providersConfiguration` (1.x camelCase alias) as fallback", () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
      providersConfiguration: {
        "@acme/gmail-mcp": { tools: ["legacy_tool"], scopes: ["legacy_scope"] },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.tools).toEqual(["legacy_tool"]);
    expect(out[0]!.scopes).toEqual(["legacy_scope"]);
  });

  it("canonical wins over `providersConfiguration` on conflict", () => {
    const out = parseManifestIntegrations({
      dependencies: {
        integrations: {
          "@acme/gmail-mcp": { version: "^1.0.0", tools: ["canonical"] },
        },
      },
      providersConfiguration: {
        "@acme/gmail-mcp": { tools: ["legacy"] },
      },
    });
    expect(out[0]!.tools).toEqual(["canonical"]);
  });

  it("1.x camelCase manifest round-trips to AFPS 2.0 canonical snake_case", () => {
    // Simulate a manifest stored before the 2.0 migration. read → write
    // upgrades it to the canonical shape; the camelCase alias is gone.
    const legacy: Record<string, unknown> = {
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
      providersConfiguration: {
        "@acme/gmail-mcp": {
          tools: ["list_messages"],
          scopes: ["gmail.readonly"],
        },
      },
    };
    const entries = parseManifestIntegrations(legacy);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tools).toEqual(["list_messages"]);
    expect(entries[0]!.scopes).toEqual(["gmail.readonly"]);

    writeManifestIntegrations(legacy, entries);

    // Writer emits canonical AFPS 2.0 only.
    expect(legacy.dependencies).toEqual({
      integrations: {
        "@acme/gmail-mcp": {
          version: "^1.0.0",
          scopes: ["gmail.readonly"],
          tools: ["list_messages"],
        },
      },
    });
    // The 1.x alias and the legacy top-level + deprecated alias are gone.
    expect(legacy.providersConfiguration).toBeUndefined();
    expect(legacy.integrations).toBeUndefined();
    expect(legacy.integrations_configuration).toBeUndefined();
  });

  it("pure AFPS 2.0 snake_case manifest round-trips identity", () => {
    const canonical: Record<string, unknown> = {
      dependencies: {
        integrations: {
          "@acme/gmail-mcp": {
            version: "^1.0.0",
            scopes: ["gmail.readonly"],
            tools: ["list_messages"],
          },
        },
      },
    };
    const entries = parseManifestIntegrations(canonical);
    writeManifestIntegrations(canonical, entries);
    expect(canonical.dependencies).toEqual({
      integrations: {
        "@acme/gmail-mcp": {
          version: "^1.0.0",
          scopes: ["gmail.readonly"],
          tools: ["list_messages"],
        },
      },
    });
    expect(canonical.providersConfiguration).toBeUndefined();
    expect(canonical.integrations).toBeUndefined();
    expect(canonical.integrations_configuration).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────
  // AFPS 2.0 §4.1 `auth_key` (C2) — multi-auth selector threading.
  // ───────────────────────────────────────────────────────────────────

  it("parseManifestIntegrations extracts `auth_key` from canonical dep object form (§4.1)", () => {
    const out = parseManifestIntegrations({
      dependencies: {
        integrations: {
          "@acme/github-mcp": { version: "^1.0.0", auth_key: "pat" },
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.auth_key).toBe("pat");
  });

  it("parseManifestIntegrations extracts `auth_key` from deprecated `integrations_configuration` alias (§4.4)", () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/github-mcp": "^1.0.0" } },
      integrations_configuration: {
        "@acme/github-mcp": { auth_key: "pat" },
      },
    });
    expect(out[0]!.auth_key).toBe("pat");
  });

  it("parseManifestIntegrations extracts `auth_key` from legacy top-level `integrations` block", () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/github-mcp": "^1.0.0" } },
      integrations: {
        "@acme/github-mcp": { auth_key: "legacy-pat" },
      },
    });
    expect(out[0]!.auth_key).toBe("legacy-pat");
  });

  it("canonical `auth_key` wins over deprecated alias + legacy top-level on conflict", () => {
    const out = parseManifestIntegrations({
      dependencies: {
        integrations: {
          "@acme/github-mcp": { version: "^1.0.0", auth_key: "canonical" },
        },
      },
      integrations_configuration: {
        "@acme/github-mcp": { auth_key: "alias" },
      },
      integrations: {
        "@acme/github-mcp": { auth_key: "legacy" },
      },
    });
    expect(out[0]!.auth_key).toBe("canonical");
  });

  it("writeManifestIntegrations emits `auth_key` in canonical object form", () => {
    const m: Record<string, unknown> = {};
    writeManifestIntegrations(m, [{ id: "@acme/github-mcp", version: "^1.0.0", auth_key: "pat" }]);
    expect(m.dependencies).toEqual({
      integrations: {
        "@acme/github-mcp": { version: "^1.0.0", auth_key: "pat" },
      },
    });
  });

  it("writeManifestIntegrations prevents collapse-to-string when `auth_key` is set", () => {
    // Even without tools/scopes, an entry carrying `auth_key` MUST stay in
    // object form — otherwise the pin would be lost on save.
    const m: Record<string, unknown> = {};
    writeManifestIntegrations(m, [{ id: "@acme/github-mcp", version: "^1.0.0", auth_key: "pat" }]);
    const deps = m.dependencies as { integrations: Record<string, unknown> };
    expect(typeof deps.integrations["@acme/github-mcp"]).toBe("object");
  });

  it("round-trips: parse(write({ id, version, auth_key })) equals input", () => {
    const m: Record<string, unknown> = {};
    const entries = [{ id: "@acme/github-mcp", version: "^1.0.0", auth_key: "pat" }];
    writeManifestIntegrations(m, entries);
    const parsed = parseManifestIntegrations(m);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe("@acme/github-mcp");
    expect(parsed[0]!.version).toBe("^1.0.0");
    expect(parsed[0]!.auth_key).toBe("pat");
  });

  it("round-trips the full triple (tools + scopes + auth_key)", () => {
    const m: Record<string, unknown> = {};
    const entries = [
      {
        id: "@acme/github-mcp",
        version: "^1.0.0",
        tools: ["list_issues"],
        scopes: ["repo"],
        auth_key: "oauth",
      },
    ];
    writeManifestIntegrations(m, entries);
    const parsed = parseManifestIntegrations(m);
    expect(parsed[0]!.tools).toEqual(["list_issues"]);
    expect(parsed[0]!.scopes).toEqual(["repo"]);
    expect(parsed[0]!.auth_key).toBe("oauth");
  });

  it("empty / missing `auth_key` still collapses to bare semver string", () => {
    const m: Record<string, unknown> = {};
    writeManifestIntegrations(m, [{ id: "@acme/github-mcp", version: "^1.0.0" }]);
    expect(m.dependencies).toEqual({
      integrations: { "@acme/github-mcp": "^1.0.0" },
    });
  });
});

describe("detectCycle", () => {
  it("self-reference detected", async () => {
    const deps: DepEntry[] = [
      { depScope: "@acme", depName: "pkg-a", depType: "skill", versionRange: "^1.0.0" },
    ];
    const result = await detectCycle("@acme/pkg-a", deps, async () => []);
    expect(result.hasCycle).toBe(true);
    expect(result.cyclePath).toContain("@acme/pkg-a");
  });

  it("direct cycle A→B→A", async () => {
    const deps: DepEntry[] = [
      { depScope: "@acme", depName: "pkg-b", depType: "skill", versionRange: "^1.0.0" },
    ];
    const resolveDeps = async (_scope: string, name: string): Promise<DepEntry[]> => {
      if (name === "pkg-b") {
        return [{ depScope: "@acme", depName: "pkg-a", depType: "skill", versionRange: "^1.0.0" }];
      }
      return [];
    };
    const result = await detectCycle("@acme/pkg-a", deps, resolveDeps);
    expect(result.hasCycle).toBe(true);
    expect(result.cyclePath).toBeDefined();
    expect(result.cyclePath![0]).toBe("@acme/pkg-a");
    expect(result.cyclePath![result.cyclePath!.length - 1]).toBe("@acme/pkg-a");
  });

  it("transitive cycle A→B→C→A", async () => {
    const deps: DepEntry[] = [
      { depScope: "@acme", depName: "pkg-b", depType: "skill", versionRange: "^1.0.0" },
    ];
    const resolveDeps = async (_scope: string, name: string): Promise<DepEntry[]> => {
      if (name === "pkg-b") {
        return [{ depScope: "@acme", depName: "pkg-c", depType: "skill", versionRange: "^1.0.0" }];
      }
      if (name === "pkg-c") {
        return [{ depScope: "@acme", depName: "pkg-a", depType: "skill", versionRange: "^1.0.0" }];
      }
      return [];
    };
    const result = await detectCycle("@acme/pkg-a", deps, resolveDeps);
    expect(result.hasCycle).toBe(true);
    expect(result.cyclePath).toBeDefined();
    expect(result.cyclePath!.length).toBeGreaterThanOrEqual(3);
  });

  it("valid DAG — no cycle", async () => {
    const deps: DepEntry[] = [
      { depScope: "@acme", depName: "pkg-b", depType: "skill", versionRange: "^1.0.0" },
      { depScope: "@acme", depName: "pkg-c", depType: "integration", versionRange: "^1.0.0" },
    ];
    const resolveDeps = async (_scope: string, name: string): Promise<DepEntry[]> => {
      if (name === "pkg-b") {
        return [{ depScope: "@acme", depName: "pkg-d", depType: "skill", versionRange: "^1.0.0" }];
      }
      // pkg-c and pkg-d have no deps
      return [];
    };
    const result = await detectCycle("@acme/pkg-a", deps, resolveDeps);
    expect(result.hasCycle).toBe(false);
    expect(result.cyclePath).toBeUndefined();
  });

  it("resolveDeps returns empty — no cycle", async () => {
    const deps: DepEntry[] = [
      { depScope: "@acme", depName: "pkg-b", depType: "skill", versionRange: "^1.0.0" },
    ];
    const result = await detectCycle("@acme/pkg-a", deps, async () => []);
    expect(result.hasCycle).toBe(false);
  });

  it("no direct deps — no cycle", async () => {
    const result = await detectCycle("@acme/pkg-a", [], async () => []);
    expect(result.hasCycle).toBe(false);
  });

  it("diamond dependency — no cycle", async () => {
    // A → B, A → C, B → D, C → D (diamond, not circular)
    const deps: DepEntry[] = [
      { depScope: "@acme", depName: "pkg-b", depType: "skill", versionRange: "^1.0.0" },
      { depScope: "@acme", depName: "pkg-c", depType: "skill", versionRange: "^1.0.0" },
    ];
    const resolveDeps = async (_scope: string, name: string): Promise<DepEntry[]> => {
      if (name === "pkg-b" || name === "pkg-c") {
        return [{ depScope: "@acme", depName: "pkg-d", depType: "skill", versionRange: "^1.0.0" }];
      }
      return [];
    };
    const result = await detectCycle("@acme/pkg-a", deps, resolveDeps);
    expect(result.hasCycle).toBe(false);
  });

  it("detects a cycle that crosses an mcp-server hop", async () => {
    // integration → mcp-server → integration (back to root)
    // Confirms `depType: "mcp-server"` flows through cycle detection
    // just like skill/integration — regression guard for the dep
    // extractor previously ignoring `dependencies.mcp_servers`.
    const deps: DepEntry[] = [
      { depScope: "@acme", depName: "mcp-srv", depType: "mcp-server", versionRange: "^1.0.0" },
    ];
    const resolveDeps = async (_scope: string, name: string): Promise<DepEntry[]> => {
      if (name === "mcp-srv") {
        return [
          { depScope: "@acme", depName: "integ-a", depType: "integration", versionRange: "^1.0.0" },
        ];
      }
      return [];
    };
    const result = await detectCycle("@acme/integ-a", deps, resolveDeps);
    expect(result.hasCycle).toBe(true);
    expect(result.cyclePath).toBeDefined();
    expect(result.cyclePath![0]).toBe("@acme/integ-a");
    expect(result.cyclePath![result.cyclePath!.length - 1]).toBe("@acme/integ-a");
  });
});
