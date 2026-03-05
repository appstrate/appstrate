import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  queues,
  resetQueues,
  db,
  schemaStubs,
  builtinPackagesStub,
  packageStorageStub,
  registryClientStub,
} from "./_db-mock.ts";

// --- Mocks ---

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));
mock.module("@appstrate/db/schema", () => schemaStubs);
mock.module("../builtin-packages.ts", () => builtinPackagesStub);
mock.module("../package-storage.ts", () => packageStorageStub);
mock.module("@appstrate/registry-client", () => registryClientStub);

// --- Import after mocks ---

const { topoSort, computePublishStatus, buildGraph, getPublishPlan } =
  await import("../dependency-graph.ts");
import type { DependencyGraph, GraphNode } from "../dependency-graph.ts";

// --- Helper ---

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    packageId: "@test/pkg",
    type: "skill",
    displayName: "Test Pkg",
    version: "1.0.0",
    lastPublishedVersion: null,
    source: "local",
    ...overrides,
  };
}

function makeGraph(
  nodeEntries: [string, Partial<GraphNode>][],
  edgeEntries: [string, string[]][],
): DependencyGraph {
  const nodes = new Map<string, GraphNode>();
  for (const [id, overrides] of nodeEntries) {
    nodes.set(id, makeNode({ packageId: id, ...overrides }));
  }
  const edges = new Map<string, Set<string>>();
  for (const [id, deps] of edgeEntries) {
    edges.set(id, new Set(deps));
  }
  return { nodes, edges };
}

// --- Unit tests: pure functions ---

describe("computePublishStatus", () => {
  test("returns no_version when version is null", () => {
    expect(computePublishStatus(makeNode({ version: null }))).toBe("no_version");
  });

  test("returns no_version when version is invalid", () => {
    expect(computePublishStatus(makeNode({ version: "not-semver" }))).toBe("no_version");
  });

  test("returns unpublished when lastPublishedVersion is null", () => {
    expect(computePublishStatus(makeNode({ version: "1.0.0", lastPublishedVersion: null }))).toBe(
      "unpublished",
    );
  });

  test("returns outdated when version is ahead of lastPublishedVersion", () => {
    expect(
      computePublishStatus(makeNode({ version: "2.0.0", lastPublishedVersion: "1.0.0" })),
    ).toBe("outdated");
  });

  test("returns version_behind when version is behind lastPublishedVersion", () => {
    expect(
      computePublishStatus(makeNode({ version: "1.0.0", lastPublishedVersion: "1.0.1" })),
    ).toBe("version_behind");
  });

  test("returns published when versions match", () => {
    expect(
      computePublishStatus(makeNode({ version: "1.0.0", lastPublishedVersion: "1.0.0" })),
    ).toBe("published");
  });
});

describe("topoSort", () => {
  test("handles single node", () => {
    const graph = makeGraph([["A", {}]], [["A", []]]);
    const { order, circular } = topoSort(graph);
    expect(circular).toBeNull();
    expect(order).toEqual(["A"]);
  });

  test("handles linear chain A→B→C (A depends on B, B depends on C)", () => {
    const graph = makeGraph(
      [
        ["A", {}],
        ["B", {}],
        ["C", {}],
      ],
      [
        ["A", ["B"]],
        ["B", ["C"]],
        ["C", []],
      ],
    );
    const { order, circular } = topoSort(graph);
    expect(circular).toBeNull();
    // C first (no deps), then B, then A
    expect(order).toEqual(["C", "B", "A"]);
  });

  test("handles diamond: A→B, A→C, B→D, C→D", () => {
    const graph = makeGraph(
      [
        ["A", {}],
        ["B", {}],
        ["C", {}],
        ["D", {}],
      ],
      [
        ["A", ["B", "C"]],
        ["B", ["D"]],
        ["C", ["D"]],
        ["D", []],
      ],
    );
    const { order, circular } = topoSort(graph);
    expect(circular).toBeNull();
    // D must come first, A must come last
    expect(order[0]).toBe("D");
    expect(order[order.length - 1]).toBe("A");
    expect(order.indexOf("B")).toBeGreaterThan(order.indexOf("D"));
    expect(order.indexOf("C")).toBeGreaterThan(order.indexOf("D"));
  });

  test("detects cycle A→B→A", () => {
    const graph = makeGraph(
      [
        ["A", {}],
        ["B", {}],
      ],
      [
        ["A", ["B"]],
        ["B", ["A"]],
      ],
    );
    const { circular } = topoSort(graph);
    expect(circular).not.toBeNull();
    expect(circular).toContain("A");
    expect(circular).toContain("B");
  });

  test("handles empty graph", () => {
    const graph: DependencyGraph = {
      nodes: new Map(),
      edges: new Map(),
    };
    const { order, circular } = topoSort(graph);
    expect(circular).toBeNull();
    expect(order).toEqual([]);
  });
});

// --- Integration tests (with DB mock) ---

describe("buildGraph", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns empty graph when root package not found", async () => {
    queues.select = [[]]; // package lookup returns nothing
    const graph = await buildGraph("@test/missing", "org-1");
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges.size).toBe(0);
  });

  test("returns single node for package without dependencies", async () => {
    queues.select = [
      // Package lookup
      [
        {
          id: "@test/flow",
          type: "flow",
          name: "My Flow",
          manifest: { displayName: "My Flow", version: "1.0.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      // Dependencies lookup
      [],
    ];

    const graph = await buildGraph("@test/flow", "org-1");
    expect(graph.nodes.size).toBe(1);
    expect(graph.nodes.has("@test/flow")).toBe(true);
    expect(graph.edges.get("@test/flow")?.size).toBe(0);
  });

  test("excludes built-in packages", async () => {
    queues.select = [
      // Root package
      [
        {
          id: "@test/flow",
          type: "flow",
          name: "Flow",
          manifest: { version: "1.0.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      // Dependencies: one dep
      [{ dependencyId: "@test/builtin-skill" }],
      // Built-in skill lookup
      [
        {
          id: "@test/builtin-skill",
          type: "skill",
          name: "Built-in",
          manifest: { version: "1.0.0" },
          lastPublishedVersion: null,
          source: "built-in",
        },
      ],
    ];

    const graph = await buildGraph("@test/flow", "org-1");
    expect(graph.nodes.size).toBe(1);
    expect(graph.nodes.has("@test/builtin-skill")).toBe(false);
  });

  test("displayName falls back to manifest.name when displayName absent", async () => {
    queues.select = [
      [
        {
          id: "@test/flow",
          type: "flow",
          name: "db-name",
          manifest: { name: "Manifest Name", version: "1.0.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      [], // no deps
    ];
    const graph = await buildGraph("@test/flow", "org-1");
    expect(graph.nodes.get("@test/flow")!.displayName).toBe("Manifest Name");
  });

  test("displayName falls back to pkg.name when manifest has neither", async () => {
    queues.select = [
      [
        {
          id: "@test/flow",
          type: "flow",
          name: "DB Column Name",
          manifest: { version: "1.0.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      [],
    ];
    const graph = await buildGraph("@test/flow", "org-1");
    expect(graph.nodes.get("@test/flow")!.displayName).toBe("DB Column Name");
  });

  test("displayName falls back to packageId when all sources are falsy", async () => {
    queues.select = [
      [
        {
          id: "@test/flow",
          type: "flow",
          name: "",
          manifest: { version: "1.0.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      [],
    ];
    const graph = await buildGraph("@test/flow", "org-1");
    expect(graph.nodes.get("@test/flow")!.displayName).toBe("@test/flow");
  });

  test("builds graph with one level of dependencies", async () => {
    queues.select = [
      // Root flow
      [
        {
          id: "@test/flow",
          type: "flow",
          name: "Flow",
          manifest: { displayName: "Test Flow", version: "1.0.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      // Flow deps
      [{ dependencyId: "@test/skill-a" }],
      // Skill A
      [
        {
          id: "@test/skill-a",
          type: "skill",
          name: "Skill A",
          manifest: { displayName: "Skill A", version: "0.1.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      // Skill A deps
      [],
    ];

    const graph = await buildGraph("@test/flow", "org-1");
    expect(graph.nodes.size).toBe(2);
    expect(graph.edges.get("@test/flow")?.has("@test/skill-a")).toBe(true);
  });
});

describe("getPublishPlan", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns empty plan for missing package", async () => {
    queues.select = [[]];
    const plan = await getPublishPlan("@test/missing", "org-1");
    expect(plan.items).toEqual([]);
    expect(plan.circular).toBeNull();
  });

  test("returns plan with correct statuses", async () => {
    queues.select = [
      // Root flow
      [
        {
          id: "@test/flow",
          type: "flow",
          name: "Flow",
          manifest: { displayName: "Test Flow", version: "2.0.0" },
          lastPublishedVersion: "1.0.0",
          source: "local",
        },
      ],
      // Flow deps
      [{ dependencyId: "@test/skill" }],
      // Skill
      [
        {
          id: "@test/skill",
          type: "skill",
          name: "Skill",
          manifest: { displayName: "Test Skill", version: "1.0.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      // Skill deps
      [],
    ];

    const plan = await getPublishPlan("@test/flow", "org-1");
    expect(plan.circular).toBeNull();
    expect(plan.items).toHaveLength(2);

    // Skill first (no deps), flow second
    expect(plan.items[0]!.packageId).toBe("@test/skill");
    expect(plan.items[0]!.status).toBe("unpublished");
    expect(plan.items[1]!.packageId).toBe("@test/flow");
    expect(plan.items[1]!.status).toBe("outdated");
  });

  test("targetVersion overrides root version", async () => {
    queues.select = [
      [
        {
          id: "@test/flow",
          type: "flow",
          name: "Flow",
          manifest: { version: "1.0.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      [],
    ];

    const plan = await getPublishPlan("@test/flow", "org-1", "2.0.0");
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.version).toBe("2.0.0");
  });

  test("targetVersion does not affect dependencies", async () => {
    queues.select = [
      [
        {
          id: "@test/flow",
          type: "flow",
          name: "Flow",
          manifest: { version: "1.0.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      [{ dependencyId: "@test/skill" }],
      [
        {
          id: "@test/skill",
          type: "skill",
          name: "Skill",
          manifest: { version: "0.5.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      [],
    ];

    const plan = await getPublishPlan("@test/flow", "org-1", "3.0.0");
    const skill = plan.items.find((i) => i.packageId === "@test/skill");
    expect(skill!.version).toBe("0.5.0");
  });

  test("targetVersion on unpublished root keeps unpublished status", async () => {
    queues.select = [
      [
        {
          id: "@test/flow",
          type: "flow",
          name: "Flow",
          manifest: { version: "0.1.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      [],
    ];

    const plan = await getPublishPlan("@test/flow", "org-1", "1.0.0");
    expect(plan.items[0]!.status).toBe("unpublished");
  });

  test("targetVersion on missing root returns empty plan", async () => {
    queues.select = [[]];
    const plan = await getPublishPlan("@test/missing", "org-1", "1.0.0");
    expect(plan.items).toEqual([]);
  });

  test("detects circular dependencies", async () => {
    queues.select = [
      // Package A
      [
        {
          id: "@test/a",
          type: "flow",
          name: "A",
          manifest: { version: "1.0.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      // A deps → B
      [{ dependencyId: "@test/b" }],
      // Package B
      [
        {
          id: "@test/b",
          type: "skill",
          name: "B",
          manifest: { version: "1.0.0" },
          lastPublishedVersion: null,
          source: "local",
        },
      ],
      // B deps → A (circular!)
      [{ dependencyId: "@test/a" }],
      // A already in nodes, skip
    ];

    const plan = await getPublishPlan("@test/a", "org-1");
    expect(plan.circular).not.toBeNull();
    expect(plan.items).toEqual([]);
  });
});
