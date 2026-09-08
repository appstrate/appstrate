// SPDX-License-Identifier: Apache-2.0

/**
 * The import-cycle gate's three pure halves: the resolver, the SCC search, and
 * the both-directions reviewer.
 *
 * The cases that matter are the negative controls. A cycle detector that
 * reports nothing is indistinguishable from a clean repo, and every way this
 * one can under-report is a silent pass: a specifier form the resolver cannot
 * express drops an EDGE, a file the population excludes drops a NODE, and
 * either can hide a cycle. So the resolver is asserted to classify an
 * out-of-scope hit and an unresolvable hit distinctly (both are gate failures
 * in `main`, neither is a silent skip), and the SCC search is driven on the
 * shapes that break naive implementations.
 */

import { describe, it, expect } from "bun:test";
import {
  BASELINE,
  cycleKey,
  findCycles,
  resolveSpecifier,
  reviewCycles,
  shortestCycleThrough,
  summaryLine,
  type ResolveContext,
} from "../verify-import-cycles.ts";

/** Build a graph from an adjacency literal. */
function graphOf(adjacency: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(adjacency).map(([from, to]) => [from, new Set(to)]));
}

/** Synthetic resolve context — no repo, no filesystem. */
function context(over: Partial<ResolveContext> = {}): ResolveContext {
  return {
    population: new Set([
      "apps/api/src/a.ts",
      "apps/api/src/b.ts",
      "apps/api/src/nested/index.ts",
      "apps/web/src/lib/c.tsx",
      "packages/core/src/naming.ts",
    ]),
    tracked: new Set([
      "apps/api/src/a.ts",
      "apps/api/src/b.ts",
      "apps/api/src/nested/index.ts",
      "apps/api/test/helpers/seed.ts",
      "apps/web/src/lib/c.tsx",
      "packages/core/src/naming.ts",
    ]),
    workspaceExports: new Map([["@appstrate/core/naming", "packages/core/src/naming.ts"]]),
    workspaceExportPatterns: [
      ["@appstrate/ui/components/", "", "packages/ui/src/components/*.tsx"],
    ],
    ...over,
  };
}

describe("resolveSpecifier", () => {
  const ctx = context();

  it("resolves an explicit .ts relative specifier", () => {
    expect(resolveSpecifier("apps/api/src/a.ts", "./b.ts", ctx)).toEqual({
      kind: "in-scope",
      target: "apps/api/src/b.ts",
    });
  });

  it("resolves an extensionless relative specifier", () => {
    expect(resolveSpecifier("apps/api/src/a.ts", "./b", ctx)).toEqual({
      kind: "in-scope",
      target: "apps/api/src/b.ts",
    });
  });

  it("resolves a directory to its index", () => {
    expect(resolveSpecifier("apps/api/src/a.ts", "./nested", ctx)).toEqual({
      kind: "in-scope",
      target: "apps/api/src/nested/index.ts",
    });
  });

  it("resolves the `@/` alias against the importing workspace", () => {
    // apps/web's only tsconfig `paths` entry. Missing it would drop most of the
    // SPA's edges while the gate still reported a file count.
    expect(resolveSpecifier("apps/web/src/pages/x.tsx", "@/lib/c", ctx)).toEqual({
      kind: "in-scope",
      target: "apps/web/src/lib/c.tsx",
    });
  });

  it("resolves a workspace package subpath through its exports map", () => {
    // Without this a `core → db → core` file cycle would be invisible, because
    // every cross-package edge would read as `external`.
    expect(resolveSpecifier("apps/api/src/a.ts", "@appstrate/core/naming", ctx)).toEqual({
      kind: "in-scope",
      target: "packages/core/src/naming.ts",
    });
  });

  it("expands a `*` exports pattern", () => {
    expect(
      resolveSpecifier("apps/web/src/lib/c.tsx", "@appstrate/ui/components/button", ctx),
    ).toEqual({ kind: "unresolved", attempted: "packages/ui/src/components/button.tsx" });
  });

  // Node allows one `*` in a pattern KEY but substitutes every occurrence in
  // the TARGET, so `./dist/*/index-*.ts` is legal. A first-occurrence
  // replacement leaves the second star literal, the path does not exist, and
  // the import falls through to `external` — an unscanned edge the gate would
  // never mention. Regression control for the `replaceAll` in
  // `resolveSpecifier`; with `.replace` this expects
  // `packages/ui/src/button/index-*.ts` and fails.
  it("substitutes EVERY star in a multi-star exports target", () => {
    const multi = context({
      workspaceExportPatterns: [
        ["@appstrate/ui/deep/", "", "packages/ui/src/*/index-*.ts"] as const,
      ],
    });
    expect(resolveSpecifier("apps/web/src/a.tsx", "@appstrate/ui/deep/button", multi)).toEqual({
      kind: "unresolved",
      attempted: "packages/ui/src/button/index-button.ts",
    });
  });

  it("reports a third-party specifier as external", () => {
    expect(resolveSpecifier("apps/api/src/a.ts", "hono", ctx)).toEqual({ kind: "external" });
    expect(resolveSpecifier("apps/api/src/a.ts", "node:path", ctx)).toEqual({ kind: "external" });
  });

  it("distinguishes a tracked file OUTSIDE the population from an external one", () => {
    // The tripwire that stops the population from silently shrinking: this is a
    // real TypeScript module, so an edge into it exists, but the scan does not
    // hold the node. `main` fails on this rather than dropping the edge.
    expect(resolveSpecifier("apps/api/src/a.ts", "../test/helpers/seed.ts", ctx)).toEqual({
      kind: "out-of-scope",
      target: "apps/api/test/helpers/seed.ts",
    });
  });

  it("reports a relative specifier that matches nothing", () => {
    expect(resolveSpecifier("apps/api/src/a.ts", "./gone", ctx)).toEqual({
      kind: "unresolved",
      attempted: "apps/api/src/gone",
    });
  });

  it("maps a .js specifier onto its .ts source", () => {
    expect(resolveSpecifier("apps/api/src/a.ts", "./b.js", ctx)).toEqual({
      kind: "in-scope",
      target: "apps/api/src/b.ts",
    });
  });
});

describe("findCycles", () => {
  it("reports nothing for an acyclic graph", () => {
    expect(findCycles(graphOf({ a: ["b"], b: ["c"], c: [] }))).toEqual([]);
  });

  it("finds a two-file cycle", () => {
    expect(findCycles(graphOf({ a: ["b"], b: ["a"] }))).toEqual([["a", "b"]]);
  });

  it("finds a cycle reachable only through an acyclic prefix", () => {
    // The shape a DFS that only starts from sources would miss.
    expect(findCycles(graphOf({ entry: ["a"], a: ["b"], b: ["c"], c: ["a"] }))).toEqual([
      ["a", "b", "c"],
    ]);
  });

  it("keeps two disjoint cycles apart", () => {
    expect(findCycles(graphOf({ a: ["b"], b: ["a"], x: ["y"], y: ["x"] }))).toEqual([
      ["a", "b"],
      ["x", "y"],
    ]);
  });

  it("reports one component for two cycles sharing a node", () => {
    // Not two entries: strongly connected is strongly connected, and a path key
    // would report the same knot twice with different member orders.
    expect(findCycles(graphOf({ a: ["b"], b: ["a", "c"], c: ["b"] }))).toEqual([["a", "b", "c"]]);
  });

  it("sorts members, so discovery order cannot change the key", () => {
    const forward = findCycles(graphOf({ z: ["a"], a: ["z"] }));
    const reverse = findCycles(graphOf({ a: ["z"], z: ["a"] }));
    expect(forward).toEqual([["a", "z"]]);
    expect(cycleKey(forward[0]!)).toBe(cycleKey(reverse[0]!));
  });

  it("does not report a self-import as a cycle", () => {
    expect(findCycles(graphOf({ a: ["a"] }))).toEqual([]);
  });

  it("ignores an edge to a node outside the graph", () => {
    expect(findCycles(graphOf({ a: ["b", "elsewhere"], b: ["a"] }))).toEqual([["a", "b"]]);
  });
});

describe("shortestCycleThrough", () => {
  it("returns the short way round, not the long one", () => {
    // The message has to point at the edge to delete; a member list of 24 files
    // does not.
    const graph = graphOf({ a: ["b", "x"], b: ["a"], x: ["y"], y: ["a"] });
    expect(shortestCycleThrough("a", ["a", "b", "x", "y"], graph)).toEqual(["a", "b", "a"]);
  });
});

describe("reviewCycles", () => {
  const graph = graphOf({ a: ["b"], b: ["a"] });
  const cycle = [["a", "b"]];

  it("accepts a cycle the baseline names", () => {
    const review = reviewCycles(cycle, [{ members: ["a", "b"], reason: "x" }], graph, 10, 20);
    expect(review.problems).toEqual([]);
    expect(review.baselined).toBe(1);
  });

  it("accepts it whatever order the baseline lists the members in", () => {
    const review = reviewCycles(cycle, [{ members: ["b", "a"], reason: "x" }], graph, 10, 20);
    expect(review.problems).toEqual([]);
  });

  it("fails a cycle with no entry, printing the path and the lines to paste", () => {
    const review = reviewCycles(cycle, [], graph, 10, 20);
    expect(review.fresh).toBe(1);
    expect(review.problems).toHaveLength(1);
    expect(review.problems[0]).toContain("import cycle across 2 file(s)");
    expect(review.problems[0]).toContain("→ b");
    expect(review.problems[0]).toContain('"a",');
    expect(review.problems[0]).toContain("reason:");
  });

  it("fails a baseline entry that matches no cycle any more", () => {
    // Both directions. Without this the list rots into a museum of fixed knots,
    // and the next cycle drawn through those files arrives pre-approved.
    const review = reviewCycles([], [{ members: ["a", "b"], reason: "x" }], graph, 10, 20);
    expect(review.stale).toBe(1);
    expect(review.problems).toHaveLength(1);
    expect(review.problems[0]).toContain("matches no cycle any more");
  });

  it("treats a knot that gained a member as new AND its old entry as stale", () => {
    // The intended, felt consequence of keying on the member set: a changed
    // component is two findings, and both need reading.
    const grown = graphOf({ a: ["b"], b: ["c"], c: ["a"] });
    const review = reviewCycles(
      [["a", "b", "c"]],
      [{ members: ["a", "b"], reason: "x" }],
      grown,
      10,
      20,
    );
    expect(review.fresh).toBe(1);
    expect(review.stale).toBe(1);
    expect(review.problems).toHaveLength(2);
  });

  it("counts what it inspected, so a vacuous run is distinguishable", () => {
    expect(summaryLine(reviewCycles([], [], new Map(), 1242, 4880))).toBe(
      "1242 file(s), 4880 runtime import edge(s) — 0 cycle(s): 0 baselined, 0 new, " +
        "0 stale baseline entry(ies).",
    );
  });
});

describe("BASELINE", () => {
  it("holds no duplicate component", () => {
    // Two entries with the same member set both match, both count as live, and
    // neither is ever reported dead — invisible weight in a list nobody
    // re-derives. The runtime both-directions check structurally cannot see it.
    const keys = BASELINE.map((entry) => cycleKey(entry.members));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("lists every entry's members sorted, matching what the gate prints", () => {
    for (const entry of BASELINE) {
      expect(entry.members).toEqual([...entry.members].sort());
    }
  });

  it("gives every entry a reason and at least two members", () => {
    for (const entry of BASELINE) {
      expect(entry.members.length).toBeGreaterThanOrEqual(2);
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });
});
