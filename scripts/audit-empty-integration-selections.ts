// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy audit CLI for the declared-but-empty integration gate.
 *
 *   bun scripts/audit-empty-integration-selections.ts           # human table
 *   bun scripts/audit-empty-integration-selections.ts --json    # machine
 *
 * Read-only. Exits 1 only when an affected artifact is selected by a normal
 * application default or an enabled schedule. Drafts and historical versions
 * that require an explicit selector remain visible as warnings and exit 0.
 *
 * All logic lives in the service so it resolves its deps and stays testable —
 * same split as `scripts/storage-orphans.ts`.
 */

import {
  auditEmptyIntegrationSelections,
  isBlocking,
  isReachable,
} from "../apps/api/src/services/audit-empty-integration-selections.ts";

const asJson = process.argv.includes("--json");
const findings = await auditEmptyIntegrationSelections();
const reachable = findings.filter(isReachable);
const blocking = findings.filter(isBlocking);
const warnings = reachable.filter((f) => !isBlocking(f));

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        findings,
        reachableCount: reachable.length,
        blockingCount: blocking.length,
        warningCount: warnings.length,
      },
      null,
      2,
    ) + "\n",
  );
} else if (findings.length === 0) {
  process.stdout.write("No agent artifact exposes zero callable integration tools.\n");
} else {
  process.stdout.write(
    `${findings.length} affected artifact(s): ${blocking.length} blocking, ` +
      `${warnings.length} warning(s), ${findings.length - reachable.length} informational.\n\n`,
  );
  for (const f of findings) {
    const status = isBlocking(f) ? "BLOCK" : isReachable(f) ? "WARN" : "INFO";
    const explicitlySelectableIn = f.installedIn.filter((id) => !f.activeIn.includes(id));
    const where = [
      ...(f.activeIn.length > 0 ? [`default in ${f.activeIn.join(", ")}`] : []),
      ...(explicitlySelectableIn.length > 0
        ? [`explicitly selectable in ${explicitlySelectableIn.join(", ")}`]
        : []),
      ...(f.schedules.length > 0
        ? [
            `schedules: ${f.schedules
              .map((s) => `${s.id}@${s.nextRunAt ?? "unscheduled"}`)
              .join(", ")}`,
          ]
        : []),
      ...(f.installedIn.length === 0 && f.schedules.length === 0 ? ["not installed"] : []),
    ].join(" | ");
    process.stdout.write(
      `  [${status}] ${f.packageId} [${f.artifact}] -> ${f.integrationId}\n` +
        `    ${f.reason}\n    ${where}\n`,
    );
  }
  if (blocking.length > 0) {
    process.stdout.write(
      "\nBlocking rows are selected by default or by an enabled schedule and will\n" +
        "fail at boot. Fix or retarget those consumers before deploying.\n",
    );
  }
  if (warnings.length > 0) {
    process.stdout.write(
      "\nWarnings require an explicit draft/version selector. They stay visible for\n" +
        "cleanup but do not block this deployment gate.\n",
    );
  }
}

process.exit(blocking.length > 0 ? 1 : 0);
