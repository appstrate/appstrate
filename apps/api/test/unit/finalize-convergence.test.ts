// SPDX-License-Identifier: Apache-2.0

/**
 * Static convergence guard — every transition into a terminal `runs.status`
 * (`success | failed | timeout | cancelled`) must flow through `finalizeRun`
 * (or `synthesiseFinalize`, which calls it). Without this invariant, a
 * future regression that reintroduces a direct `db.update(runs).set({
 * status: 'cancelled' })` would silently bypass the `afterRun` hook and
 * skip billing — exactly the bug this whole PR fixes.
 *
 * The test grep-walks `apps/api/src/**` and fails if a `runs` UPDATE that
 * sets a terminal status appears in any file other than the canonical
 * convergence point. Cheap, no AST, attaches to the existing unit-test
 * channel — pre-execution feedback in CI.
 *
 * What's intentionally allowed:
 *   - `runs.status = 'running'` (the sole non-terminal transition, owned
 *     by `executeAgentInBackground`) — terminal-only regex
 *   - `db.insert(runs).values({ status: 'failed' })` — preflight failures
 *     that never reached an LLM (no resources to bill); INSERT, not UPDATE
 *   - References inside type unions, comments, JSDoc, or test helpers
 *
 * What's forbidden outside the allowlist:
 *   - `db.update(runs).set({ status: 'cancelled' | 'failed' | 'timeout' | 'success' })`
 *   - `updateRun(..., { status: '<terminal>' })`
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "..", "src");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/**
 * Files allowed to write a terminal status to `runs`. Each entry is a
 * relative path from the repo root, matched exactly.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // Canonical convergence — `finalizeRun` CAS, `synthesiseFinalize` helper,
  // and the per-event sequence advance (which never sets terminal status).
  "apps/api/src/services/run-event-ingestion.ts",
]);

/**
 * Files allowed to INSERT a row with terminal status (preflight-failed runs
 * that never reached the LLM). Different from UPDATE because there is no
 * resource consumption to account for, and no in-flight sink to close.
 */
const INSERT_ALLOWLIST: ReadonlySet<string> = new Set([
  "apps/api/src/services/state/runs.ts", // createFailedRun (INSERT only)
]);

const TERMINAL_STATUSES = ["cancelled", "failed", "timeout", "success"] as const;
const TERMINAL_STATUS_RE = new RegExp(`status:\\s*"(${TERMINAL_STATUSES.join("|")})"`);
const UPDATE_RUNS_RE = /\.update\s*\(\s*runs\s*\)/;
const INSERT_RUNS_RE = /\.insert\s*\(\s*runs\s*\)/;
const UPDATE_RUN_FN_RE = /\bupdateRun\s*\(/;

interface Violation {
  file: string;
  line: number;
  snippet: string;
  reason: string;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip the OpenAPI spec tree (response examples are documentation,
      // not runtime DB writes) and any test directories.
      if (entry === "openapi" || entry === "test" || entry === "node_modules") continue;
      yield* walk(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      yield full;
    }
  }
}

function findUpdateViolations(
  content: string,
  lines: string[],
): Array<{ line: number; window: string }> {
  // Hunt for `.update(runs)` then check the next ~12 lines for a terminal
  // status assignment. The CAS in finalizeRun spans about that range.
  const violations: Array<{ line: number; window: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!UPDATE_RUNS_RE.test(lines[i]!)) continue;
    const window = lines.slice(i, Math.min(i + 12, lines.length)).join("\n");
    if (TERMINAL_STATUS_RE.test(window)) {
      violations.push({ line: i + 1, window });
    }
  }
  // Also catch the `updateRun(scope, id, { status: 'failed' })` pattern.
  for (let i = 0; i < lines.length; i++) {
    if (!UPDATE_RUN_FN_RE.test(lines[i]!)) continue;
    const window = lines.slice(i, Math.min(i + 6, lines.length)).join("\n");
    if (TERMINAL_STATUS_RE.test(window)) {
      violations.push({ line: i + 1, window });
    }
  }
  void content; // unused — lines array is the source of truth
  return violations;
}

function findInsertViolations(
  _content: string,
  lines: string[],
): Array<{ line: number; window: string }> {
  const violations: Array<{ line: number; window: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!INSERT_RUNS_RE.test(lines[i]!)) continue;
    const window = lines.slice(i, Math.min(i + 12, lines.length)).join("\n");
    if (TERMINAL_STATUS_RE.test(window)) {
      violations.push({ line: i + 1, window });
    }
  }
  return violations;
}

describe("finalize convergence — static guard", () => {
  it("no file outside the convergence allowlist transitions runs to a terminal status", () => {
    const violations: Violation[] = [];

    for (const file of walk(SRC_ROOT)) {
      const rel = relative(REPO_ROOT, file);
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");

      const updateHits = findUpdateViolations(content, lines);
      if (updateHits.length > 0 && !ALLOWLIST.has(rel)) {
        for (const hit of updateHits) {
          violations.push({
            file: rel,
            line: hit.line,
            snippet: hit.window.slice(0, 200),
            reason:
              "UPDATE on `runs` writes a terminal status outside the convergence allowlist. " +
              "Route the transition through `synthesiseFinalize` so `afterRun` (billing) fires.",
          });
        }
      }

      const insertHits = findInsertViolations(content, lines);
      if (insertHits.length > 0 && !INSERT_ALLOWLIST.has(rel)) {
        for (const hit of insertHits) {
          violations.push({
            file: rel,
            line: hit.line,
            snippet: hit.window.slice(0, 200),
            reason:
              "INSERT on `runs` with terminal status outside the preflight allowlist. " +
              "If this represents a run that consumed resources, route through `finalizeRun` instead.",
          });
        }
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map((v) => `\n  ${v.file}:${v.line}\n    → ${v.reason}\n    snippet: ${v.snippet}`)
        .join("\n");
      throw new Error(
        `Found ${violations.length} convergence violation(s). Every terminal-status transition on \`runs\` MUST flow through \`finalizeRun\` so the \`afterRun\` hook fires for billing/observability:${report}`,
      );
    }

    expect(violations).toHaveLength(0);
  });

  it("the allowlist itself is non-empty and points at the canonical finalize file", () => {
    // Sanity check — if someone inadvertently empties the allowlist this
    // test wouldn't catch real violations because every terminal status
    // would belong to "an unallowed file" (vacuously true).
    expect(ALLOWLIST.size).toBeGreaterThan(0);
    expect(ALLOWLIST.has("apps/api/src/services/run-event-ingestion.ts")).toBe(true);
  });
});
