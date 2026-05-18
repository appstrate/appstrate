// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  extractDependencies,
  detectCycle,
  parseManifestIntegrations,
} from "../src/dependencies.ts";
import type { DepEntry } from "../src/dependencies.ts";

describe("extractDependencies", () => {
  it("manifest with skills and tools", () => {
    const manifest = {
      dependencies: {
        skills: { "@acme/skill-a": "^1.0.0", "@acme/skill-b": "~2.0.0" },
        tools: { "@acme/ext-c": ">=1.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(3);

    const skillA = deps.find((d) => d.depName === "skill-a");
    expect(skillA).toBeDefined();
    expect(skillA!.depScope).toBe("@acme");
    expect(skillA!.depType).toBe("skill");
    expect(skillA!.versionRange).toBe("^1.0.0");

    const extC = deps.find((d) => d.depName === "ext-c");
    expect(extC).toBeDefined();
    expect(extC!.depType).toBe("tool");
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

  it("manifest with providers", () => {
    const manifest = {
      dependencies: {
        providers: { "@acme/slack": "^1.0.0", "@acme/github": "~2.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(2);

    const slack = deps.find((d) => d.depName === "slack");
    expect(slack).toBeDefined();
    expect(slack!.depScope).toBe("@acme");
    expect(slack!.depType).toBe("provider");
    expect(slack!.versionRange).toBe("^1.0.0");
  });

  it("manifest with skills, tools, and providers", () => {
    const manifest = {
      dependencies: {
        skills: { "@acme/skill-a": "^1.0.0" },
        tools: { "@acme/ext-a": "^1.0.0" },
        providers: { "@acme/slack": "^1.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(3);
    expect(deps.find((d) => d.depType === "skill")).toBeDefined();
    expect(deps.find((d) => d.depType === "tool")).toBeDefined();
    expect(deps.find((d) => d.depType === "provider")).toBeDefined();
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

  it("manifest with integrations in niveau 2 rich object form", () => {
    const manifest = {
      dependencies: {
        integrations: {
          "@acme/gmail-mcp": {
            version: "^1.0.0",
            tools: ["list_messages"],
            scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          },
        },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.depType).toBe("integration");
    expect(deps[0]!.versionRange).toBe("^1.0.0");
  });

  it("throws on malformed integration value (object without version)", () => {
    const manifest = {
      dependencies: {
        integrations: { "@acme/gmail-mcp": { tools: ["list_messages"] } },
      },
    };
    expect(() => extractDependencies(manifest)).toThrow(/Invalid integration dependency/);
  });
});

describe("parseManifestIntegrations", () => {
  it("returns empty list for manifest without integrations", () => {
    expect(parseManifestIntegrations({})).toEqual([]);
    expect(parseManifestIntegrations({ dependencies: {} })).toEqual([]);
  });

  it("normalises bare version strings to { version, tools: undefined }", () => {
    const out = parseManifestIntegrations({
      dependencies: { integrations: { "@acme/gmail-mcp": "^1.0.0" } },
    });
    expect(out).toEqual([
      { id: "@acme/gmail-mcp", version: "^1.0.0", tools: undefined, scopes: undefined },
    ]);
  });

  it("preserves tools/scopes from the rich form", () => {
    const out = parseManifestIntegrations({
      dependencies: {
        integrations: {
          "@acme/gmail-mcp": {
            version: "^1.0.0",
            tools: ["list_messages", "get_message"],
            scopes: ["s1", "s2"],
          },
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("@acme/gmail-mcp");
    expect(out[0]!.tools).toEqual(["list_messages", "get_message"]);
    expect(out[0]!.scopes).toEqual(["s1", "s2"]);
  });

  it("skips invalid entries silently (object without version)", () => {
    const out = parseManifestIntegrations({
      dependencies: {
        integrations: {
          "@acme/ok": "^1.0.0",
          "@acme/bad": { tools: ["x"] },
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("@acme/ok");
  });

  it("filters non-string entries inside tools/scopes arrays", () => {
    const out = parseManifestIntegrations({
      dependencies: {
        integrations: {
          "@acme/gmail-mcp": {
            version: "^1.0.0",
            tools: ["good", 42, null, "another"],
            scopes: ["s1", false, "s2"],
          },
        },
      },
    });
    expect(out[0]!.tools).toEqual(["good", "another"]);
    expect(out[0]!.scopes).toEqual(["s1", "s2"]);
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
      { depScope: "@acme", depName: "pkg-c", depType: "tool", versionRange: "^1.0.0" },
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
});
