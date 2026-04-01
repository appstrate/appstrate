import { describe, expect, test } from "bun:test";
import { extractDependencies, detectCycle } from "../src/dependencies.ts";
import type { DepEntry } from "../src/dependencies.ts";

describe("extractDependencies", () => {
  test("manifest with skills and tools", () => {
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

  test("manifest without dependencies", () => {
    const deps = extractDependencies({});
    expect(deps).toHaveLength(0);
  });

  test("manifest with empty dependencies", () => {
    const deps = extractDependencies({ dependencies: {} });
    expect(deps).toHaveLength(0);
  });

  test("scoped names are parsed correctly", () => {
    const manifest = {
      dependencies: {
        skills: { "@my-org/cool-skill": "^1.0.0" },
      },
    };
    const deps = extractDependencies(manifest);
    expect(deps[0]!.depScope).toBe("@my-org");
    expect(deps[0]!.depName).toBe("cool-skill");
  });

  test("manifest with providers", () => {
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

  test("manifest with skills, tools, and providers", () => {
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

  test("throws on invalid scoped package name", () => {
    const manifest = {
      dependencies: {
        skills: { "invalid-name": "^1.0.0" },
      },
    };
    expect(() => extractDependencies(manifest)).toThrow(
      "Invalid scoped package name: invalid-name",
    );
  });
});

describe("detectCycle", () => {
  test("self-reference detected", async () => {
    const deps: DepEntry[] = [
      { depScope: "@acme", depName: "pkg-a", depType: "skill", versionRange: "^1.0.0" },
    ];
    const result = await detectCycle("@acme/pkg-a", deps, async () => []);
    expect(result.hasCycle).toBe(true);
    expect(result.cyclePath).toContain("@acme/pkg-a");
  });

  test("direct cycle A→B→A", async () => {
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

  test("transitive cycle A→B→C→A", async () => {
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

  test("valid DAG — no cycle", async () => {
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

  test("resolveDeps returns empty — no cycle", async () => {
    const deps: DepEntry[] = [
      { depScope: "@acme", depName: "pkg-b", depType: "skill", versionRange: "^1.0.0" },
    ];
    const result = await detectCycle("@acme/pkg-a", deps, async () => []);
    expect(result.hasCycle).toBe(false);
  });

  test("no direct deps — no cycle", async () => {
    const result = await detectCycle("@acme/pkg-a", [], async () => []);
    expect(result.hasCycle).toBe(false);
  });

  test("diamond dependency — no cycle", async () => {
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
