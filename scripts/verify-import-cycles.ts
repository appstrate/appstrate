#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Gate — circular imports across the TypeScript workspaces.
 *
 * Nothing detected them. `verify-module-isolation.ts` answers a different
 * question (may module A reach into module B's tree); a cycle sits happily
 * inside one module, one directory, or one file pair. What a runtime cycle
 * costs is a partially-initialised module: whichever file the loader enters
 * first sees the other's bindings in their temporal dead zone, so a
 * module-scope `const` read during evaluation is `undefined` — or a
 * `ReferenceError` — depending only on which entrypoint the process happened to
 * import first. That is the class of bug that reproduces in one test file and
 * not the next.
 *
 * ─── Tool choice: Tarjan here, not dependency-cruiser ────────────────
 *
 * `dependency-cruiser` is the famous answer and was rejected on merits, not on
 * novelty. It brings a `.dependency-cruiser.cjs` rule DSL — a configuration
 * language nobody else in this repo uses or reads — its own known-violations
 * baseline format, `enhanced-resolve`, and ~30 transitive dependencies, to
 * express one rule. `eslint-plugin-import`'s `import/no-cycle` was rejected for
 * a measured reason as well: lint is already the dominant cost of `bun run
 * check`, and `no-cycle` re-walks the import graph per file.
 *
 * What is here instead is Tarjan's SCC algorithm over an import graph — the
 * whole gate is one pass, one file, no config — and it buys two properties an
 * off-the-shelf cruiser does not give:
 *
 *   - The population cannot silently shrink. A relative import that resolves to
 *     a tracked TypeScript file OUTSIDE the scanned set FAILS the gate instead
 *     of being dropped, so a new source root reports itself.
 *   - Import extraction is `Bun.Transpiler.scanImports`, a real parser, not a
 *     regex. That is not a style preference: the regex form this repo already
 *     uses in `verify-module-isolation.ts` reads `{@link import("./x.ts").Foo}`
 *     inside a JSDoc block as an import. Measured 2026-09-08 — the regex
 *     reported 8 cycles, one of which (`packages/core` dependencies →
 *     integration → validation) existed only because of the `@link` on line 45
 *     of `packages/core/src/dependencies.ts`. The parser reports 7.
 *
 * ─── Type-only imports are NOT counted, and the number that says so ──
 *
 * `import type` / `export type` / an all-`type` named clause are erased before
 * the module ever runs, so they cannot produce a TDZ read. They are also the
 * majority of what a naive scan would report: measured 2026-09-08, counting
 * them takes this repo from 7 cycles over 40 files to 17 over 71. Nine of those
 * ten extra cycles are pure type edges — entries a developer could only
 * "fix" by moving an interface, for no runtime effect, and a baseline that
 * doubles for that reason is a baseline people stop reading.
 *
 * The distinction is reliable rather than best-effort because
 * `tsconfig.base.json` sets `verbatimModuleSyntax: true`: a type import in this
 * repo MUST carry the `type` keyword, and a plain `import { X }` is emitted
 * verbatim, i.e. really is a runtime edge. `Bun.Transpiler.scanImports` applies
 * exactly that rule — verified 2026-09-08 against eleven shapes, including
 * `import { type A, b }` (kept, because of `b`), a value import used only as a
 * type (kept, conservatively) and `export type { A } from` (dropped).
 *
 * ─── What "one cycle" means, and why the key is a member SET ─────────
 *
 * The unit reported is a strongly connected component, not a path. A path key
 * would make one knot look like many — the 24-file `apps/api/src/services`
 * component below contains thousands of distinct cycles through the same files
 * — and the member order of a path is arbitrary, so the same knot would key
 * differently on different runs. An SCC's member set is canonical: sorted, it
 * is the same string however the graph was walked.
 *
 * The consequence is worth stating because it is felt: adding a file to an
 * existing knot, or breaking one edge so a knot splits, changes the key and the
 * gate goes red until BASELINE is updated. That is the intended behaviour —
 * both are changes to a cyclic cluster that somebody should look at — and the
 * failure message prints the exact lines to delete and to paste.
 *
 * Usage: bun scripts/verify-import-cycles.ts
 */

import { dirname, join } from "node:path";
import { trackedFiles, trackedIndexFiles } from "./lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Which files are in the graph.
 *
 * Prefixes rather than a roster: `apps/<w>/src`, `packages/<w>/src` and all of
 * `runtime-pi` (which has no `src/` — its modules sit at the workspace root and
 * under `sidecar/`). A new app or package is in scope the day it is committed.
 *
 * The `git ls-files` pathspec passed to `trackedFiles` is the flat `*.ts` /
 * `*.tsx` pair from `SOURCE_GLOBS`, and the narrowing happens here in code, on
 * purpose: git's `**` does NOT match at zero depth, so the obvious
 * `packages/<w>/src/<glob>.ts` (a `**` pathspec) silently omits `packages/ui/src/cn.ts` — measured
 * 2026-09-08, 31 imports of that one file resolved to nothing under that
 * pathspec. Turbo's `**` behaves the opposite way (see `//#verify:env-docs` in
 * turbo.json), which is exactly why neither behaviour should be assumed.
 */
const IN_SCOPE = /^(?:apps\/[^/]+\/src\/|packages\/[^/]+\/src\/|runtime-pi\/)/;

/**
 * Test files are out of the graph.
 *
 * Not a measurement dodge — a structural one. A test imports product code and
 * nothing imports a test, so a test file is always a sink and can never be part
 * of a cycle. Confirmed rather than assumed: including them 2026-09-08 added
 * 239 files and 476 edges and changed the reported cycle set by nothing. What
 * it did change is that 145 imports then resolved to files outside the scanned
 * population (`apps/api/test/helpers/**`), which this gate treats as a failure
 * — so admitting tests would mean either widening the population to the test
 * trees or reintroducing a silent drop.
 */
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.tsx?$/;

/** Extensions a specifier may resolve to, in the order a bundler tries them. */
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"] as const;

/**
 * A cycle this repo carries today, recorded so it cannot grow unnoticed.
 *
 * ─── Checked in BOTH directions ──────────────────────────────────────
 *
 * `reviewCycles` fails on a live cycle with no entry AND on an entry matching
 * no live cycle. The second half is the one that keeps the list honest: without
 * it, a knot somebody untangles leaves a line here that reads as a hazard the
 * codebase still has, and the next person to add a cycle to those same files
 * finds it pre-approved.
 *
 * ─── Why the members are listed in full ──────────────────────────────
 *
 * A 24-line entry is a lot of lines, and that is the point: this list is the
 * repo's cyclic surface, in the file, where a reviewer sees it grow. It is not
 * a count to be nodded at.
 *
 * Seeded 2026-09-08 from a clean tree: 7 components over 40 files, out of 1 242
 * files and 4 880 runtime edges. There is no `--update-baseline`, for the same
 * reason `lint-migrations.ts` has none — a regeneration flag is a way to clear
 * a new cycle without reading it. The gate prints the lines to paste.
 */
export interface AcceptedCycle {
  /** SCC members, repo-relative, sorted. The key. */
  members: readonly string[];
  reason: string;
}

export const BASELINE: readonly AcceptedCycle[] = [
  {
    // apps/api/src/services/agent-readiness.ts → integration-connections.ts →
    // spaces.ts → files.ts → run-event-ingestion.ts → inline-run.ts →
    // run-pipeline.ts → agent-readiness.ts (one of many paths through it).
    reason:
      "The run pipeline and the package/integration services are one mutually recursive " +
      "cluster, not 24 independent mistakes: launching a run reaches package resolution, " +
      "which reaches space installation, which reaches run state, which reaches the launcher " +
      "again. Recorded whole so that adding a 25th file to the knot fails this gate — " +
      "untangling it is a refactor, not a gate fix.",
    members: [
      "apps/api/src/services/agent-readiness.ts",
      "apps/api/src/services/files.ts",
      "apps/api/src/services/inline-run.ts",
      "apps/api/src/services/input-parser.ts",
      "apps/api/src/services/integration-connection-resolver.ts",
      "apps/api/src/services/integration-connections.ts",
      "apps/api/src/services/integration-org-defaults-service.ts",
      "apps/api/src/services/integration-pins-service.ts",
      "apps/api/src/services/integration-spawn-resolver.ts",
      "apps/api/src/services/package-catalog.ts",
      "apps/api/src/services/run-boot-heartbeat.ts",
      "apps/api/src/services/run-context-builder.ts",
      "apps/api/src/services/run-effective-agent.ts",
      "apps/api/src/services/run-event-ingestion.ts",
      "apps/api/src/services/run-launcher/appstrate-event-sink.ts",
      "apps/api/src/services/run-launcher/execute-background.ts",
      "apps/api/src/services/run-launcher/pi.ts",
      "apps/api/src/services/run-metric-broadcaster.ts",
      "apps/api/src/services/run-pipeline.ts",
      "apps/api/src/services/run-preflight-gates.ts",
      "apps/api/src/services/space-packages.ts",
      "apps/api/src/services/spaces.ts",
      "apps/api/src/services/state/notifications.ts",
      "apps/api/src/services/state/runs.ts",
    ],
  },
  {
    // agent-version-resolver → package-versions → package-storage →
    // run-launcher/run-package-catalog → agent-version-resolver.
    reason:
      "Package version resolution and the run-launcher's catalogs resolve through each other: " +
      "the launcher asks the catalog for a version, the catalog reads stored package bytes, " +
      "and the storage layer resolves the version again.",
    members: [
      "apps/api/src/services/agent-version-resolver.ts",
      "apps/api/src/services/package-storage.ts",
      "apps/api/src/services/package-versions.ts",
      "apps/api/src/services/run-launcher/db-package-catalog.ts",
      "apps/api/src/services/run-launcher/run-package-catalog.ts",
    ],
  },
  {
    // use-current-space → use-spaces → use-org-scope → use-current-space.
    reason:
      "The three org/space scope hooks are mutually recursive: the current-space hook lists " +
      "spaces, the list is fetched under the org-only scope, and that scope reads the current " +
      "space. React hooks are called at render time rather than at module evaluation, so the " +
      "TDZ hazard does not bite here — but the knot is real and a fourth hook joining it should " +
      "be noticed.",
    members: [
      "apps/web/src/hooks/use-current-space.ts",
      "apps/web/src/hooks/use-org-scope.ts",
      "apps/web/src/hooks/use-spaces.ts",
    ],
  },
  {
    reason:
      "The infra barrel constructs the Redis cookie-jar store, and the store calls back into " +
      "the barrel's `getCache()` for its backing cache instead of taking one. Injecting the " +
      "cache would break it.",
    members: ["apps/api/src/infra/cookie-jar/redis-cookie-jar.ts", "apps/api/src/infra/index.ts"],
  },
  {
    reason:
      "`agent-detail-handler.ts` was split out of `packages.ts` but still imports `getItemId` " +
      "from it, while `packages.ts` mounts the handler. Moving `getItemId` to a third module " +
      "would break it.",
    members: ["apps/api/src/routes/agent-detail-handler.ts", "apps/api/src/routes/packages.ts"],
  },
  {
    reason:
      "`package-paths.ts` reads `PACKAGE_CONFIG` out of the `use-packages` hook module while " +
      "the hook imports `splitPackageRef` back. The constant belongs in neither — it is data.",
    members: ["apps/web/src/hooks/use-packages.ts", "apps/web/src/lib/package-paths.ts"],
  },
  {
    reason:
      "Two Drizzle table modules with foreign keys pointing at each other. Mutual references " +
      "are the normal shape for a bidirectional relation in Drizzle's schema-as-modules design; " +
      "table objects are built lazily enough that the cycle does not bite at import time.",
    members: ["packages/db/src/schema/organizations.ts", "packages/db/src/schema/spaces.ts"],
  },
];

/** How a specifier resolved, from the graph's point of view. */
export type Resolution =
  | { kind: "in-scope"; target: string }
  | { kind: "out-of-scope"; target: string }
  | { kind: "external" }
  | { kind: "unresolved"; attempted: string };

/** What `resolveSpecifier` needs to answer, gathered once by `main`. */
export interface ResolveContext {
  /** Repo-relative paths in the graph. */
  population: ReadonlySet<string>;
  /** Every tracked `.ts`/`.tsx` path, used to tell "out of scope" from "gone". */
  tracked: ReadonlySet<string>;
  /** `@appstrate/core/naming` → `packages/core/src/naming.ts`, from `exports` maps. */
  workspaceExports: ReadonlyMap<string, string>;
  /** `["@appstrate/ui/components/", ".tsx-less suffix", "packages/ui/src/components/*.tsx"]`. */
  workspaceExportPatterns: readonly (readonly [prefix: string, suffix: string, template: string])[];
}

/**
 * Resolve one import specifier to a repo-relative file, or say why not.
 *
 * Three specifier families are resolved and they are the three this repo writes:
 * relative (`./x.ts`, `../y`), the `@/` alias `apps/web/tsconfig.json` maps to
 * that workspace's `src/`, and a workspace package subpath resolved through the
 * importee's own `exports` map.
 *
 * Resolving workspace packages is what makes "no cross-package cycle" a checked
 * statement instead of a hopeful one. Before it, `@appstrate/core/naming` was
 * simply "external" and a `core → db → core` file cycle would have been
 * invisible. It costs almost nothing here because every `exports` map in this
 * repo is a plain `"./sub": "./src/file.ts"` string map — 124 entries and a
 * single `*` pattern (`@appstrate/ui`'s `./components/*`), checked 2026-09-08
 * across all 20 workspace manifests. If a conditional (`{ "import": … }`) map
 * ever appears, this returns `external` for it and the entry is skipped
 * silently; that is the one blind spot here, and it is bounded by the fact that
 * `bun run check` typechecks every one of those imports anyway.
 */
export function resolveSpecifier(fromFile: string, spec: string, ctx: ResolveContext): Resolution {
  let base: string | null = null;

  if (spec.startsWith(".")) {
    base = join(dirname(fromFile), spec);
  } else if (spec.startsWith("@/")) {
    // `@/*` → `<workspace>/src/*`, the only tsconfig `paths` alias in the repo.
    base = join(fromFile.split("/").slice(0, 2).join("/"), "src", spec.slice(2));
  } else {
    const exact = ctx.workspaceExports.get(spec);
    if (exact !== undefined) base = exact;
    else {
      for (const [prefix, suffix, template] of ctx.workspaceExportPatterns) {
        if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
        const star = spec.slice(prefix.length, spec.length - suffix.length);
        base = template.replace("*", star);
        break;
      }
    }
    if (base === null) return { kind: "external" };
  }

  base = base.replace(/\\/g, "/");

  const candidates = [base];
  for (const ext of EXTENSIONS) candidates.push(base + ext);
  // `moduleResolution: "bundler"` + `allowImportingTsExtensions` means this repo
  // writes `./x.ts` directly, but a `./x.js` specifier still has to land on
  // `x.ts` for the graph to be complete.
  if (base.endsWith(".js")) {
    for (const ext of EXTENSIONS) candidates.push(base.slice(0, -3) + ext);
  }
  for (const ext of EXTENSIONS) candidates.push(`${base}/index${ext}`);

  for (const candidate of candidates) {
    if (ctx.population.has(candidate)) return { kind: "in-scope", target: candidate };
  }
  for (const candidate of candidates) {
    if (ctx.tracked.has(candidate)) return { kind: "out-of-scope", target: candidate };
  }
  return { kind: "unresolved", attempted: base };
}

/** Assets a source file may legitimately import that are not TypeScript modules. */
const ASSET_SPECIFIER = /\.(?:json|ya?ml|css|svg|png|jpe?g|webp|txt|md|sql|wasm)$/;

/**
 * Every strongly connected component of size ≥ 2, each sorted, the list ordered
 * largest first.
 *
 * Iterative Tarjan — the recursive form blows Bun's stack on a graph this deep
 * (the 24-node component sits inside a 1 242-node graph with 4 880 edges).
 * Pure, so `scripts/test/verify-import-cycles.test.ts` drives it on hand-built
 * graphs including the shapes that break naive implementations: two disjoint
 * cycles, a cycle reachable only through an acyclic prefix, and a component
 * whose discovery order differs from its sorted order.
 *
 * Self-edges are not cycles here. A file importing itself is a typo TypeScript
 * already reports, and counting it would put single-file entries in a baseline
 * about module knots.
 */
export function findCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of graph.keys()) {
    if (index.has(root)) continue;

    // Each frame is [node, next successor to visit].
    const frames: [string, number][] = [[root, 0]];
    index.set(root, counter);
    lowLink.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const [node, cursor] = frame;
      const successors = [...(graph.get(node) ?? [])];

      if (cursor < successors.length) {
        frame[1]++;
        const next = successors[cursor]!;
        if (!graph.has(next)) continue;
        if (!index.has(next)) {
          index.set(next, counter);
          lowLink.set(next, counter);
          counter++;
          stack.push(next);
          onStack.add(next);
          frames.push([next, 0]);
        } else if (onStack.has(next)) {
          lowLink.set(node, Math.min(lowLink.get(node)!, index.get(next)!));
        }
        continue;
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        lowLink.set(parent[0], Math.min(lowLink.get(parent[0])!, lowLink.get(node)!));
      }
      if (lowLink.get(node) !== index.get(node)) continue;

      const component: string[] = [];
      let popped: string;
      do {
        popped = stack.pop()!;
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== node);
      if (component.length > 1) components.push(component.sort());
    }
  }

  return components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

/** The canonical key for a component: its sorted members. */
export function cycleKey(members: readonly string[]): string {
  return [...members].sort().join("\n");
}

/**
 * One concrete cycle through `members[0]`, for the failure message.
 *
 * An SCC's member list says WHICH files are tangled; it does not say which
 * import to delete. A BFS back to the start node gives the shortest path, which
 * is the smallest set of edges a developer has to look at.
 */
export function shortestCycleThrough(
  start: string,
  members: readonly string[],
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const inComponent = new Set(members);
  const previous = new Map<string, string>();
  const queue = [start];

  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of graph.get(node) ?? []) {
      if (!inComponent.has(next)) continue;
      if (next === start) {
        const path = [start];
        const tail: string[] = [];
        for (let at = node; at !== start; at = previous.get(at)!) tail.push(at);
        return [...path, ...tail.reverse(), start];
      }
      if (previous.has(next)) continue;
      previous.set(next, node);
      queue.push(next);
    }
  }
  // Unreachable for a real SCC (every member reaches every other by
  // definition); returning the degenerate path keeps this total.
  return [start, start];
}

/** What one review pass concluded, with the counts that prove it read something. */
export interface CycleReview {
  problems: string[];
  files: number;
  edges: number;
  cycles: number;
  baselined: number;
  fresh: number;
  stale: number;
}

/**
 * Decide which components are new and which baseline entries have gone stale.
 * Pure — `main` feeds it the real graph, the tests feed it fixtures.
 */
export function reviewCycles(
  cycles: readonly string[][],
  baseline: readonly AcceptedCycle[],
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  files: number,
  edges: number,
): CycleReview {
  const accepted = new Map(baseline.map((entry) => [cycleKey(entry.members), entry]));
  const matched = new Set<string>();
  const problems: string[] = [];
  let baselined = 0;
  let fresh = 0;

  for (const members of cycles) {
    const key = cycleKey(members);
    if (accepted.has(key)) {
      matched.add(key);
      baselined++;
      continue;
    }
    fresh++;
    const path = shortestCycleThrough(members[0]!, members, graph);
    problems.push(
      `import cycle across ${members.length} file(s):\n` +
        path.map((f, i) => `    ${i === 0 ? " " : "→"} ${f}`).join("\n") +
        (members.length > path.length - 1
          ? `\n    (that is the shortest path; the whole component is ${members.length} files)`
          : "") +
        `\n    Break one edge — move the shared symbol into a module both sides import, or ` +
        `invert the dependency by passing the value in. If it is genuinely unavoidable, add ` +
        `this to BASELINE in scripts/verify-import-cycles.ts with a reason:\n` +
        `      {\n        reason: "…",\n        members: [\n` +
        members.map((m) => `          ${JSON.stringify(m)},`).join("\n") +
        `\n        ],\n      },`,
    );
  }

  // Both directions. An entry matching no live component reads as a hazard the
  // codebase still carries, and it would pre-approve the next cycle somebody
  // draws through those same files.
  for (const entry of baseline) {
    const key = cycleKey(entry.members);
    if (matched.has(key)) continue;
    problems.push(
      `BASELINE entry over ${entry.members.length} file(s) matches no cycle any more:\n` +
        entry.members.map((m) => `      ${JSON.stringify(m)},`).join("\n") +
        `\n    The cycle was broken, or it changed shape (a file joined or left it, and the new ` +
        `shape is reported above as a new cycle). Delete this entry — the component key is its ` +
        `exact member set.`,
    );
  }

  return {
    problems,
    files,
    edges,
    cycles: cycles.length,
    baselined,
    fresh,
    stale: baseline.length - matched.size,
  };
}

/** The one-line verdict, with the counts that distinguish it from a no-op run. */
export function summaryLine(review: CycleReview): string {
  return (
    `${review.files} file(s), ${review.edges} runtime import edge(s) — ${review.cycles} cycle(s): ` +
    `${review.baselined} baselined, ${review.fresh} new, ` +
    `${review.stale} stale baseline entry(ies).`
  );
}

/**
 * Every `name + subpath → file` a workspace manifest publishes, plus the `*`
 * patterns, so a bare `@appstrate/…` specifier resolves to a real file.
 */
async function readWorkspaceExports(): Promise<
  Pick<ResolveContext, "workspaceExports" | "workspaceExportPatterns">
> {
  const workspaceExports = new Map<string, string>();
  const workspaceExportPatterns: [string, string, string][] = [];

  for (const manifestPath of trackedIndexFiles(["*package.json"], "workspace manifest")) {
    if (manifestPath.includes("node_modules/")) continue;
    const manifest = (await Bun.file(join(REPO_ROOT, manifestPath)).json()) as {
      name?: string;
      exports?: Record<string, unknown> | string;
    };
    if (typeof manifest.name !== "string") continue;
    if (manifest.exports === undefined || typeof manifest.exports !== "object") continue;

    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (typeof target !== "string") continue;
      const spec = subpath === "." ? manifest.name : manifest.name + subpath.slice(1);
      const file = join(dirname(manifestPath), target).replace(/\\/g, "/");
      const star = spec.indexOf("*");
      if (star === -1) workspaceExports.set(spec, file);
      else workspaceExportPatterns.push([spec.slice(0, star), spec.slice(star + 1), file]);
    }
  }

  return { workspaceExports, workspaceExportPatterns };
}

// Guarded so `scripts/test/verify-import-cycles.test.ts` can drive the pure
// resolver, the SCC search and the reviewers without walking the repo — same
// pattern as `lint-migrations.ts` and `verify-module-isolation.ts`.
if (import.meta.main) {
  // Discovered, not listed. `"skip"` because a checkout mid-`git rm` is not a
  // cycle finding, and the population is a whole-repo sweep rather than a
  // hand-picked set whose coverage a missing file would quietly shrink.
  const tracked = trackedFiles(["*.ts", "*.tsx"], "TypeScript source file", "skip");
  // `/dist/` and `/node_modules/` are dropped here so that this population and
  // the `//#verify:import-cycles` input globs in turbo.json exclude the SAME
  // things. That symmetry is the point: those globs carry `!**/dist/**` (they
  // must — `apps/web/dist` is 310 files and 17.6 MB, and hashing it would bust
  // this task on every SPA build), and a file the script READS that turbo does
  // not HASH is a cached green over unscanned code. Neither exclusion removes
  // anything today: `git ls-files "*.ts" "*.tsx" | grep /dist/` is empty as of
  // 2026-09-08, and the count is 1 242 with or without this filter. It is here
  // so the two lists cannot drift apart in the direction that fails silently.
  const population = tracked.filter(
    (f) =>
      IN_SCOPE.test(f) &&
      !TEST_PATH.test(f) &&
      !f.includes("/node_modules/") &&
      !f.includes("/dist/"),
  );
  if (population.length === 0) {
    throw new Error(
      `no source file matched ${IN_SCOPE.source} — the cycle scan would be vacuous. ` +
        `Did a workspace move out of apps/, packages/ or runtime-pi/?`,
    );
  }

  const ctx: ResolveContext = {
    population: new Set(population),
    tracked: new Set(tracked),
    ...(await readWorkspaceExports()),
  };

  // One transpiler per loader: `.ts` must NOT be parsed as `tsx`, where `<T>x`
  // is a JSX element rather than a type assertion.
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };

  const graph = new Map<string, Set<string>>();
  const problems: string[] = [];
  let edges = 0;

  for (const file of population) {
    const source = await Bun.file(join(REPO_ROOT, file)).text();
    // `Bun.Transpiler` rejects a shebang outright ("Unexpected #!/usr/bin/env
    // bun"), and several CLI entrypoints carry one.
    const body = source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
    const out = new Set<string>();

    for (const { path: spec } of transpilers[file.endsWith(".tsx") ? "tsx" : "ts"].scanImports(
      body,
    )) {
      const resolved = resolveSpecifier(file, spec, ctx);
      if (resolved.kind === "external") continue;
      if (resolved.kind === "out-of-scope") {
        problems.push(
          `${file} imports \`${spec}\`, which resolves to ${resolved.target} — a tracked ` +
            `TypeScript file this gate does not scan. The population would be missing an edge, ` +
            `so a cycle through that file would go unreported. Widen IN_SCOPE in ` +
            `scripts/verify-import-cycles.ts.`,
        );
        continue;
      }
      if (resolved.kind === "unresolved") {
        // A non-TS asset import is expected (`./x.json`, `./y.yml`); anything
        // else means the resolver has a hole, and a hole here silently removes
        // edges from the graph.
        if (!ASSET_SPECIFIER.test(spec)) {
          problems.push(
            `${file} imports \`${spec}\`, which resolves to no tracked file (tried ` +
              `${resolved.attempted}). Either the import is broken, or resolveSpecifier in ` +
              `scripts/verify-import-cycles.ts cannot express this specifier form — and an ` +
              `edge it cannot resolve is an edge missing from the cycle search.`,
          );
        }
        continue;
      }
      if (resolved.target !== file) {
        out.add(resolved.target);
        edges++;
      }
    }

    graph.set(file, out);
  }

  const cycles = findCycles(graph);
  const review = reviewCycles(cycles, BASELINE, graph, population.length, edges);
  problems.push(...review.problems);

  for (const p of problems) console.error(`❌ ${p}`);

  if (problems.length === 0) {
    console.log(`✅ no new import cycles — ${summaryLine(review)}`);
    process.exit(0);
  }

  console.error(
    `\n❌ import cycles — ${summaryLine(review)}\n` +
      `A runtime cycle leaves one of the files half-initialised while the other evaluates, so a ` +
      `module-scope read of the other's binding is \`undefined\` or throws, depending only on ` +
      `which entrypoint the process imported first.\n` +
      `BASELINE is the cyclic surface this repo already has; it should shrink, not grow.`,
  );
  process.exit(1);
}
