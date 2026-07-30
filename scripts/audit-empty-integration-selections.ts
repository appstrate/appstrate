// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy audit CLI for the declared-but-empty integration gate.
 *
 *   bun scripts/audit-empty-integration-selections.ts           # human table
 *   bun scripts/audit-empty-integration-selections.ts --json    # machine
 *
 * Read-only. Exits 1 when at least one REACHABLE artifact is affected, so it can
 * gate a deploy; findings nothing can reach are printed and exit 0.
 *
 * All logic lives in the service so it resolves its deps and stays testable —
 * same split as `scripts/storage-orphans.ts`.
 */

import {
  auditEmptyIntegrationSelections,
  isReachable,
} from "../apps/api/src/services/audit-empty-integration-selections.ts";

const asJson = process.argv.includes("--json");
const findings = await auditEmptyIntegrationSelections();
const reachable = findings.filter(isReachable);

if (asJson) {
  process.stdout.write(
    JSON.stringify({ findings, reachableCount: reachable.length }, null, 2) + "\n",
  );
} else if (findings.length === 0) {
  process.stdout.write("No agent artifact resolves to an empty integration selection.\n");
} else {
  process.stdout.write(
    `${findings.length} affected artifact(s), ${reachable.length} reachable:\n\n`,
  );
  for (const f of findings) {
    const where =
      f.installedIn.length > 0 ? `installed in ${f.installedIn.join(", ")}` : "not installed";
    const sched =
      f.schedules.length > 0
        ? ` | schedules: ${f.schedules
            .map((s) => `${s.id}@${s.nextRunAt ?? "unscheduled"}`)
            .join(", ")}`
        : "";
    process.stdout.write(
      `  ${f.packageId} [${f.artifact}] -> ${f.integrationId}\n    ${f.reason}\n    ${where}${sched}\n`,
    );
  }
  if (reachable.length > 0) {
    process.stdout.write(
      "\nReachable rows will fail at boot once this ships. Tick a tool (or drop the\n" +
        "dependency) and re-publish BEFORE deploying.\n",
    );
  }
}

process.exit(reachable.length > 0 ? 1 : 0);
