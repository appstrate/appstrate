// SPDX-License-Identifier: Apache-2.0

/**
 * The migration lock-safety gate's reviewer, plus the one property of
 * `BASELINE` that the runtime both-directions check structurally cannot see.
 *
 * `reviewFindings` reports a baseline entry that matched nothing, which keeps
 * the list from rotting into a museum of hazards production no longer carries.
 * It cannot report a DUPLICATED entry: both copies key to the same string, both
 * are marked matched, and neither is dead — so a duplicate is invisible dead
 * weight in a list nobody re-derives. That is asserted statically below.
 */

import { describe, it, expect } from "bun:test";
import {
  BASELINE,
  parseFindings,
  reviewFindings,
  summaryLine,
  type Finding,
} from "../lint-migrations.ts";

function finding(name: string, rule: string, line = 0): Finding {
  return {
    file: `packages/db/drizzle/${name}.sql`,
    line,
    message: `synthetic ${rule}`,
    rule_name: rule,
  };
}

/** A two-entry baseline, so the cases below do not move with the real list. */
const FIXTURE_BASELINE = [
  ["0000_init", "require-lock-timeout"],
  ["0000_init", "require-statement-timeout"],
] as const;

describe("reviewFindings", () => {
  it("accepts a finding the baseline names", () => {
    const review = reviewFindings(
      [finding("0000_init", "require-lock-timeout")],
      [FIXTURE_BASELINE[0]],
      1,
    );
    expect(review.problems).toEqual([]);
    expect(review.baselined).toBe(1);
    expect(review.fresh).toBe(0);
  });

  it("rejects the same rule in a DIFFERENT migration", () => {
    // The negative control for the case above: the rule is baselined, the pair
    // is not. A baseline keyed on the rule alone would pass this.
    const review = reviewFindings(
      [finding("0057_new_thing", "require-lock-timeout", 3)],
      [FIXTURE_BASELINE[0]],
      1,
    );
    expect(review.problems).toHaveLength(2); // the finding, plus the now-stale entry
    expect(review.problems[0]).toContain("0057_new_thing.sql");
    expect(review.problems[0]).toContain("require-lock-timeout");
    // Reported as the developer reads it — 1-based, matching squawk's tty output.
    expect(review.problems[0]).toContain("line 4:");
    expect(review.problems[0]).toContain("https://squawkhq.com/docs/require-lock-timeout");
    expect(review.fresh).toBe(1);
  });

  it("groups every line of one (file, rule) pair into one finding", () => {
    const review = reviewFindings(
      [
        finding("0057_new_thing", "prefer-bigint-over-int", 1),
        finding("0057_new_thing", "prefer-bigint-over-int", 9),
      ],
      [],
      1,
    );
    expect(review.problems).toHaveLength(1);
    expect(review.problems[0]).toContain("(2 time(s))");
    expect(review.problems[0]).toContain("line 2:");
    expect(review.problems[0]).toContain("line 10:");
  });

  it("fails on a baseline entry that matches nothing", () => {
    const review = reviewFindings([], FIXTURE_BASELINE, 1);
    expect(review.stale).toBe(2);
    expect(review.problems).toHaveLength(1);
    expect(review.problems[0]).toContain("match no finding any more");
    // The exact lines to delete, so the fix is a paste rather than a hunt.
    expect(review.problems[0]).toContain('["0000_init", "require-lock-timeout"],');
  });

  it("counts what it inspected, so a vacuous run is distinguishable", () => {
    const review = reviewFindings([], [], 56);
    expect(review.problems).toEqual([]);
    expect(summaryLine(review)).toBe(
      "56 migration(s) linted — 0 finding(s): 0 baselined, 0 new, 0 stale baseline entry(ies).",
    );
  });
});

describe("parseFindings", () => {
  it("reads squawk's empty-result array", () => {
    expect(parseFindings("[]", "", 0)).toEqual([]);
  });

  it("throws on output that is not JSON, quoting stderr", () => {
    // The shape squawk produces for a bad rule name: exit 2, nothing on stdout.
    expect(() =>
      parseFindings("", "error: invalid value 'nope' for '--exclude <rule>'", 2),
    ).toThrow(/invalid value 'nope'/);
  });

  it("throws on JSON that is not an array", () => {
    expect(() => parseFindings('{"file":"x"}', "", 1)).toThrow(/expected an array/);
  });
});

describe("BASELINE", () => {
  it("holds no duplicate (migration, rule) pair", () => {
    const keys = BASELINE.map(([m, r]) => `${m} ${r}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is sorted, so a hand-added entry lands where a regeneration would put it", () => {
    const keys = BASELINE.map(([m, r]) => `${m} ${r}`);
    expect(keys).toEqual([...keys].sort());
  });
});
