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

  it("manifest with mcp_servers — AFPS first-class dep map", () => {
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

  it("throws when a dependency value is not a string (§4.1)", () => {
    const manifest = {
      dependencies: { skills: { "@acme/skill": 42 as unknown as string } },
    };
    expect(() => extractDependencies(manifest)).toThrow(/expected a semver range string/);
  });

  it("rejects the object form — dependency values are semver strings only (§4.1)", () => {
    const manifest = {
      dependencies: {
        integrations: { "@acme/gmail-mcp": { version: "^1.0.0" } as unknown as string },
      },
    };
    expect(() => extractDependencies(manifest)).toThrow(/expected a semver range string/);
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

  it("manifest with integrations as a bare semver string", () => {
    const manifest = {
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.depType).toBe("integration");
    expect(deps[0]!.versionRange).toBe("^1.0.0");
  });

  // Invalid semver range rejected upstream at extract time.
  it("throws on invalid semver range", () => {
    const manifest = {
      dependencies: { skills: { "@acme/skill": "not-a-range" } },
    };
    expect(() => extractDependencies(manifest)).toThrow(/Invalid semver range/);
  });

  it("accepts standard semver range forms", () => {
    // Sanity guard that the validator doesn't over-reject (caret, tilde,
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

  it("reads tools/scopes from integrations_configuration (§4.4)", () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
      integrations_configuration: {
        "@acme/gmail-mcp": {
          tools: ["list_messages", "get_message"],
          scopes: ["s1", "s2"],
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("@acme/gmail-mcp");
    expect(out[0]!.version).toBe("^1.0.0");
    expect(out[0]!.tools).toEqual(["list_messages", "get_message"]);
    expect(out[0]!.scopes).toEqual(["s1", "s2"]);
  });

  it("surfaces scopes/auth_key from integrations_configuration only for configured deps (§4.4)", () => {
    const out = parseManifestIntegrations({
      dependencies: {
        integrations: { "@acme/ok": "^1.0.0", "@acme/rich": "^1.0.0" },
      },
      integrations_configuration: {
        "@acme/rich": { scopes: ["s1"], auth_key: "oauth" },
      },
    });
    expect(out).toHaveLength(2);
    const rich = out.find((e) => e.id === "@acme/rich");
    expect(rich!.version).toBe("^1.0.0");
    expect(rich!.scopes).toEqual(["s1"]);
    expect(rich!.auth_key).toBe("oauth");
    const ok = out.find((e) => e.id === "@acme/ok");
    expect(ok!.scopes).toBeUndefined();
  });

  it("ignores an integrations_configuration entry with no matching dependency", () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/declared": "^1.0.0" } },
      integrations_configuration: {
        "@acme/orphan": { tools: ["x"] },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("@acme/declared");
  });

  it("filters non-string entries inside tools/scopes arrays", () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
      integrations_configuration: {
        "@acme/gmail-mcp": {
          tools: ["good", 42, null, "another"] as unknown as string[],
          scopes: ["s1", false, "s2"] as unknown as string[],
        },
      },
    });
    expect(out[0]!.tools).toEqual(["good", "another"]);
    expect(out[0]!.scopes).toEqual(["s1", "s2"]);
  });
});

describe("writeManifestIntegrations", () => {
  it("writes the version to dependencies and config to integrations_configuration (§4.4)", () => {
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
      integrations: { "@acme/gmail-mcp": "^1.0.0" },
    });
    expect(m.integrations_configuration).toEqual({
      "@acme/gmail-mcp": {
        tools: ["list_messages"],
        scopes: ["gmail.readonly"],
      },
    });
    // No Appstrate-invented top-level `integrations` block.
    expect(m.integrations).toBeUndefined();
  });

  it("leaves no integrations_configuration entry for a dep with no config", () => {
    const m: Record<string, unknown> = {};
    writeManifestIntegrations(m, [{ id: "@acme/gmail-mcp", version: "^1.0.0" }]);
    expect(m.dependencies).toEqual({
      integrations: { "@acme/gmail-mcp": "^1.0.0" },
    });
    expect(m.integrations_configuration).toBeUndefined();
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

  it("empty entries clear `dependencies.integrations`", () => {
    const m: Record<string, unknown> = {
      dependencies: { integrations: { "@acme/old": "^1.0.0" } },
    };
    writeManifestIntegrations(m, []);
    const deps = m.dependencies as Record<string, unknown>;
    expect(deps.integrations).toBeUndefined();
  });

  it("pure AFPS snake_case manifest round-trips identity", () => {
    const canonical: Record<string, unknown> = {
      dependencies: {
        integrations: { "@acme/gmail-mcp": "^1.0.0" },
      },
      integrations_configuration: {
        "@acme/gmail-mcp": {
          tools: ["list_messages"],
          scopes: ["gmail.readonly"],
        },
      },
    };
    const entries = parseManifestIntegrations(canonical);
    writeManifestIntegrations(canonical, entries);
    expect(canonical.dependencies).toEqual({
      integrations: { "@acme/gmail-mcp": "^1.0.0" },
    });
    expect(canonical.integrations_configuration).toEqual({
      "@acme/gmail-mcp": {
        tools: ["list_messages"],
        scopes: ["gmail.readonly"],
      },
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // AFPS §4.4 `auth_key` — multi-auth selector threading.
  // ───────────────────────────────────────────────────────────────────

  it("parseManifestIntegrations extracts `auth_key` from integrations_configuration (§4.4)", () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/github-mcp": "^1.0.0" } },
      integrations_configuration: {
        "@acme/github-mcp": { auth_key: "pat" },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.auth_key).toBe("pat");
  });

  it("writeManifestIntegrations emits `auth_key` in integrations_configuration", () => {
    const m: Record<string, unknown> = {};
    writeManifestIntegrations(m, [{ id: "@acme/github-mcp", version: "^1.0.0", auth_key: "pat" }]);
    expect(m.dependencies).toEqual({
      integrations: { "@acme/github-mcp": "^1.0.0" },
    });
    expect(m.integrations_configuration).toEqual({
      "@acme/github-mcp": { auth_key: "pat" },
    });
  });

  it("writeManifestIntegrations keeps the dep a bare string even when `auth_key` is set", () => {
    // The dependency value is always a semver string; `auth_key` lives in the
    // config block, so it survives the round-trip without an object dep form.
    const m: Record<string, unknown> = {};
    writeManifestIntegrations(m, [{ id: "@acme/github-mcp", version: "^1.0.0", auth_key: "pat" }]);
    const deps = m.dependencies as { integrations: Record<string, unknown> };
    expect(deps.integrations["@acme/github-mcp"]).toBe("^1.0.0");
    const config = m.integrations_configuration as Record<string, unknown>;
    expect(config["@acme/github-mcp"]).toEqual({ auth_key: "pat" });
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

  // ───────────────────────────────────────────────────────────────────
  // AFPS §4.4 wildcard tools — `"*"` opt-in passthrough
  // ───────────────────────────────────────────────────────────────────

  it('parseManifestIntegrations preserves the wildcard literal `"*"` on `tools`', () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/github-mcp": "^1.0.0" } },
      integrations_configuration: {
        "@acme/github-mcp": { tools: "*" },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.tools).toBe("*");
  });

  it('parseManifestIntegrations rejects non-`"*"` non-array strings (drops to undefined)', () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/github-mcp": "^1.0.0" } },
      integrations_configuration: {
        "@acme/github-mcp": { tools: "all" },
      },
    });
    expect(out[0]!.tools).toBeUndefined();
  });

  it('writeManifestIntegrations round-trips the wildcard `"*"` literal', () => {
    const m: Record<string, unknown> = {};
    writeManifestIntegrations(m, [
      { id: "@acme/github-mcp", version: "^1.0.0", tools: "*", auth_key: "oauth" },
    ]);
    const config = m.integrations_configuration as Record<string, { tools?: unknown }>;
    expect(config["@acme/github-mcp"]!.tools).toBe("*");
    const parsed = parseManifestIntegrations(m);
    expect(parsed[0]!.tools).toBe("*");
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
