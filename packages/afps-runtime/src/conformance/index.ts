// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS conformance suite — run a battery of spec-level cases against
 * any {@link ConformanceAdapter} implementation and produce a
 * structured report. See `AFPS_CONFORMANCE.md` (forthcoming) for the
 * level matrix:
 *
 * - L1 — Loader: ZIP parsing, required files, path sanitisation
 * - L2 — Render: logic-less Mustache semantics + sanitization
 * - L3 — Signing: Ed25519 direct + chain verification
 * - L4 — Execution (Phase 10): event emission contract
 */

import { BUILT_IN_CASES, type ConformanceCase, type ConformanceLevel } from "./cases.ts";
import type { ConformanceAdapter } from "./adapter.ts";

export {
  BUILT_IN_CASES,
  type ConformanceCase,
  type ConformanceLevel,
  type CaseResult,
} from "./cases.ts";
export { type ConformanceAdapter, type RunScriptedOutput } from "./adapter.ts";
export { createDefaultAdapter } from "./default-adapter.ts";

export interface CaseReportEntry {
  id: string;
  level: ConformanceLevel;
  title: string;
  status: "pass" | "fail" | "skipped";
  detail?: string;
  durationMs: number;
}

export interface ConformanceReport {
  adapter: string;
  levels: readonly ConformanceLevel[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  cases: readonly CaseReportEntry[];
}

export interface RunConformanceOptions {
  /** Restrict execution to these levels (default: all built-in levels). */
  levels?: readonly ConformanceLevel[];
  /** Restrict to specific case IDs (takes precedence over `levels`). */
  only?: readonly string[];
  /**
   * Extra cases to append. The built-in suite is ALWAYS included —
   * custom cases let a runner add language-specific invariants
   * without forking the reference suite.
   */
  extraCases?: readonly ConformanceCase[];
}

/**
 * Execute the suite and collect a {@link ConformanceReport}. Cases are
 * run sequentially for deterministic output; thrown errors become
 * `fail` entries (never rethrown) so a single broken adapter path
 * does not short-circuit the report.
 */
export async function runConformance(
  adapter: ConformanceAdapter,
  opts: RunConformanceOptions = {},
): Promise<ConformanceReport> {
  const all: ConformanceCase[] = [...BUILT_IN_CASES, ...(opts.extraCases ?? [])];
  const selected = selectCases(all, opts);

  const cases: CaseReportEntry[] = [];
  for (const c of selected) {
    const start = performance.now();
    let status: "pass" | "fail" | "skipped";
    let detail: string | undefined;
    try {
      const result = await c.run(adapter);
      status = result.status;
      detail = result.detail;
    } catch (err) {
      status = "fail";
      detail = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    cases.push({
      id: c.id,
      level: c.level,
      title: c.title,
      status,
      detail,
      durationMs: Math.round((performance.now() - start) * 1000) / 1000,
    });
  }

  const summary = {
    total: cases.length,
    passed: cases.filter((e) => e.status === "pass").length,
    failed: cases.filter((e) => e.status === "fail").length,
    skipped: cases.filter((e) => e.status === "skipped").length,
  };
  const levels = Array.from(new Set(cases.map((c) => c.level))).sort();

  return { adapter: adapter.name, levels, summary, cases };
}

function selectCases(all: ConformanceCase[], opts: RunConformanceOptions): ConformanceCase[] {
  if (opts.only && opts.only.length > 0) {
    const wanted = new Set(opts.only);
    return all.filter((c) => wanted.has(c.id));
  }
  if (opts.levels && opts.levels.length > 0) {
    const wanted = new Set(opts.levels);
    return all.filter((c) => wanted.has(c.level));
  }
  return all;
}

/**
 * Format a report as a human-readable text block. Deterministic and
 * free of ANSI escapes so it plays well with CI log viewers.
 */
export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`Conformance report — ${report.adapter}`);
  lines.push(`Levels: ${report.levels.join(", ")}`);
  lines.push("");
  for (const c of report.cases) {
    const mark = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "∼";
    lines.push(`  ${mark} [${c.id}] ${c.title}  (${c.durationMs}ms)`);
    if (c.status !== "pass" && c.detail) {
      lines.push(`      └─ ${c.detail}`);
    }
  }
  lines.push("");
  lines.push(
    `Summary: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed` +
      (report.summary.skipped > 0 ? `, ${report.summary.skipped} skipped` : ""),
  );
  return lines.join("\n") + "\n";
}
