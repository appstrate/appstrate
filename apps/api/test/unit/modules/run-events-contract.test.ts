// SPDX-License-Identifier: Apache-2.0

/**
 * Contract test: every terminal run status in routes/runs.ts must emit
 * `onRunStatusChange` so downstream modules (webhooks, cloud billing, …)
 * observe the transition. This is a source-based smoke test — not a full
 * behavioural test — aimed at catching regressions where a code path stops
 * emitting the event silently.
 *
 * The test parses `apps/api/src/routes/runs.ts` and asserts that each of the
 * five tracked statuses appears in at least one `emitEvent("onRunStatusChange",
 * ...)` call. We deliberately check per-status rather than a total count,
 * because consolidating two error paths into one helper is a valid refactor
 * that shouldn't break the contract — losing the emission for a status is not.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNS_ROUTE_PATH = resolve(import.meta.dir, "../../../src/routes/runs.ts");
const TRACKED_STATUSES = ["started", "success", "failed", "timeout", "cancelled"] as const;

describe("onRunStatusChange contract — routes/runs.ts", () => {
  const source = readFileSync(RUNS_ROUTE_PATH, "utf-8");

  it("emits onRunStatusChange at least once per tracked status", () => {
    const matches = source.match(/emitEvent\(\s*["']onRunStatusChange["']/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(TRACKED_STATUSES.length);
  });

  for (const status of TRACKED_STATUSES) {
    it(`has at least one emitEvent block that references status "${status}"`, () => {
      // Split the source into emitEvent payloads and check each one contains
      // the status literal. Naive but sufficient: we only care that *some*
      // payload references each tracked status.
      const blocks = source.split(/emitEvent\(\s*["']onRunStatusChange["']/).slice(1);
      const found = blocks.some((block) => {
        // Take the next ~500 chars after the call (the object literal).
        const slice = block.slice(0, 500);
        return new RegExp(`status:\\s*["']${status}["']`).test(slice);
      });
      expect(found).toBe(true);
    });
  }
});
