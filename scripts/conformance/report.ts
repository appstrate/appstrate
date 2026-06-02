// SPDX-License-Identifier: Apache-2.0

/**
 * Collect findings into a human-readable report and a process exit code.
 * `fail` findings fail the run (exit 1); `warn`/`info` are reported only.
 */

import type { Finding, Severity } from "./types.ts";

const ICON: Record<Severity, string> = { fail: "✗", warn: "⚠", info: "✓" };

export interface Summary {
  fail: number;
  warn: number;
  info: number;
  total: number;
  ok: boolean;
}

export function summarize(findings: Finding[]): Summary {
  const fail = findings.filter((f) => f.severity === "fail").length;
  const warn = findings.filter((f) => f.severity === "warn").length;
  const info = findings.filter((f) => f.severity === "info").length;
  return { fail, warn, info, total: findings.length, ok: fail === 0 };
}

/** Markdown-ish report grouped by package, ordered fail → warn → info. */
export function formatReport(findings: Finding[]): string {
  if (findings.length === 0) return "No packages matched — nothing to check.";

  const order: Record<Severity, number> = { fail: 0, warn: 1, info: 2 };
  const byPackage = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byPackage.get(f.packageId) ?? [];
    list.push(f);
    byPackage.set(f.packageId, list);
  }

  const lines: string[] = [];
  for (const [packageId, list] of [...byPackage.entries()].sort()) {
    lines.push(`\n${packageId}`);
    for (const f of [...list].sort((a, b) => order[a.severity] - order[b.severity])) {
      lines.push(`  ${ICON[f.severity]} [${f.check}] ${f.message}`);
    }
  }

  const s = summarize(findings);
  lines.push(`\n${s.fail} fail · ${s.warn} warn · ${s.info} info`);
  return lines.join("\n");
}

/** Exit code: 1 when any `fail` finding is present, else 0. */
export function exitCode(findings: Finding[]): number {
  return summarize(findings).ok ? 0 : 1;
}
