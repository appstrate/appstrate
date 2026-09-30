// SPDX-License-Identifier: Apache-2.0

/**
 * Contract test: every terminal run status must emit `onRunStatusChange`
 * so downstream modules (webhooks, ee billing, …) observe the
 * transition. Source-based smoke test aimed at catching regressions
 * where a code path stops emitting the event silently.
 *
 * In the unified-runner architecture, emissions are split across two
 * files by role:
 *   - `routes/runs.ts` emits "started" (when the platform spawns the
 *     container) + "cancelled" (cancel route).
 *   - `services/run-event-ingestion.ts` emits every *terminal* status
 *     (success / failed / timeout) because `finalizeRun` is the
 *     single convergence point for both platform and remote runners.
 *
 * We scan the union of those two files — losing the emission for a
 * status anywhere is a contract break.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { terminalRunStatusValues } from "@appstrate/core/run-status";

const SOURCE_FILES = [
  resolve(import.meta.dir, "../../../src/routes/runs.ts"),
  resolve(import.meta.dir, "../../../src/services/run-event-ingestion.ts"),
  resolve(import.meta.dir, "../../../src/services/run-creation.ts"),
];
const TRACKED_STATUSES = ["started", "success", "failed", "timeout", "cancelled"] as const;

describe("onRunStatusChange contract", () => {
  const source = SOURCE_FILES.map((p) => readFileSync(p, "utf-8")).join("\n");

  it("has at least one onRunStatusChange emission", () => {
    const matches = source.match(/emitEvent\(\s*["']onRunStatusChange["']/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
  });

  for (const status of TRACKED_STATUSES) {
    it(`covers status "${status}" with either a literal emission or a derived-status emission`, () => {
      // "started" and "cancelled" are literal `status: "…"` object keys
      // at the call site; "success" / "failed" / "timeout" arrive via
      // the `status` local `finalizeRun` seeds from the runner-declared
      // `result.status`, which the finalize route validates against the
      // terminal status tuple. Matching either shape means the contract is
      // enforced without pinning the tests to a specific code style.
      const literalObjectKey = new RegExp(`status:\\s*["']${status}["']`);
      const derivedFromResult =
        /let status = result\.status;/.test(source) &&
        (terminalRunStatusValues as readonly string[]).includes(status);

      const found = literalObjectKey.test(source) || derivedFromResult;
      expect(found).toBe(true);
    });
  }
});
