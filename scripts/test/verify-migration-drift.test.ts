// SPDX-License-Identifier: Apache-2.0

/**
 * The drift gate's two reviewers, driven against synthetic drizzle-kit results.
 *
 * The case that cannot be reached by running the real command on a clean tree
 * is the one worth a test: drizzle-kit exits **0** when it wanted to ask an
 * interactive question and could not (a rename in the diff, no TTY), printing a
 * stack trace and generating nothing. Read as "exit 0 → pass" that is a silent
 * green over unmigrated drift, so `reviewGenerate` refuses to conclude from the
 * exit code alone and this file holds both halves of that: the SAME exit code
 * and the SAME empty file set pass when the marker is present and fail when it
 * is not. Assert only the passing half and the test proves nothing, because
 * "no problems" is what the broken reading said too.
 */

import { describe, it, expect } from "bun:test";
import { reviewCheck, reviewGenerate } from "../verify-migration-drift.ts";

/** drizzle-kit's own line for "there is nothing to generate". */
const CLEAN_OUTPUT =
  "49 tables\nspaces 8 columns 2 indexes 2 fks\n\nNo schema changes, nothing to migrate 😴\n";

/** The shape a rename produces: a stack trace, no file, and exit 0 anyway. */
const PROMPT_OUTPUT =
  "49 tables\nError: Interactive prompts require a TTY terminal " +
  "(process.stdin.isTTY or process.stdout.isTTY is false).\n    at render10 (…)\n";

const NO_PENDING: ReadonlyMap<string, string> = new Map();

describe("reviewGenerate", () => {
  it("passes when drizzle-kit says there is nothing to migrate", () => {
    expect(reviewGenerate({ exitCode: 0, output: CLEAN_OUTPUT }, NO_PENDING)).toEqual([]);
  });

  it("fails on the same exit code and the same empty file set when the marker is absent", () => {
    // The negative control for the case above. Only the marker differs.
    const problems = reviewGenerate({ exitCode: 0, output: PROMPT_OUTPUT }, NO_PENDING);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("exited 0 anyway");
    expect(problems[0]).toContain("bun run db:generate");
    // The tool's own output is quoted, so the developer sees WHY it stopped.
    expect(problems[0]).toContain("Interactive prompts require a TTY terminal");
  });

  it("reports the pending SQL, not merely that there is drift", () => {
    const problems = reviewGenerate(
      { exitCode: 0, output: "49 tables\n" },
      new Map([["0056_verify_migration_drift.sql", 'ALTER TABLE "spaces" ADD COLUMN "x" text;']]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("0056_verify_migration_drift.sql");
    expect(problems[0]).toContain('ALTER TABLE "spaces" ADD COLUMN "x" text;');
    expect(problems[0]).toContain("bun run db:generate");
  });

  it("refuses to conclude when drizzle-kit itself failed", () => {
    const problems = reviewGenerate(
      { exitCode: 1, output: "Error  No schema files found for path config" },
      NO_PENDING,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("cannot tell whether");
    expect(problems[0]).toContain("No schema files found");
  });

  it("prefers the pending-file finding over the marker when both are present", () => {
    // Belt and braces: a generated file is the stronger signal, and a run that
    // somehow carried both must not be read as clean.
    const problems = reviewGenerate(
      { exitCode: 0, output: CLEAN_OUTPUT },
      new Map([["0056_x.sql", "ALTER TABLE t ADD COLUMN c text;"]]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("without a migration");
  });
});

describe("reviewCheck", () => {
  it("passes on exit 0", () => {
    expect(reviewCheck({ exitCode: 0, output: "Everything's fine 🐶🔥\n" })).toEqual([]);
  });

  it("reports a snapshot collision and says how to unwind it", () => {
    const problems = reviewCheck({
      exitCode: 1,
      output:
        "[drizzle/meta/0055_snapshot.json, drizzle/meta/0056_snapshot.json] are pointing to a " +
        "parent snapshot: drizzle/meta/0055_snapshot.json which is a collision.",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("0056_snapshot.json");
    expect(problems[0]).toContain("bun run db:generate");
  });
});
