// SPDX-License-Identifier: Apache-2.0

/**
 * The compose-drift gate's THIRD class of finding: a variable the schema gives
 * a default to that `CODE_DEFAULTS` does not name.
 *
 * `analyzeComposeDefaults` skips any variable absent from that table
 * (`codeDefault === undefined` → `continue`), so before this class existed the
 * gate's coverage was the table's length, not the schema's — and the table was
 * short by 14. The tests below hold both halves at once: the same synthetic
 * compose text that the duplicate-detector reports NOTHING about is the one the
 * gap-detector flags. Assert only one half and the pass proves nothing, because
 * "no findings" is what the broken gate said too.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findTableGaps, readSchemaDefaults, suppliesValue } from "../verify-compose-defaults.ts";
import { analyzeComposeDefaults, CODE_DEFAULTS } from "../../apps/cli/src/lib/compose-defaults.ts";
import { envSchema } from "../../packages/env/src/index.ts";

/**
 * A synthetic variable name, and that is the point.
 *
 * This case used to be written against two REAL variables —
 * `WORKSPACE_TMPFS_SIZE_MB` and `FILE_MAX_BYTES` — with
 * `expect("WORKSPACE_TMPFS_SIZE_MB" in CODE_DEFAULTS).toBe(false)` asserted
 * against the live table. The gate's own failure text tells the reader to "add
 * the variable to CODE_DEFAULTS", so following the instruction the gate prints
 * turned this test red. A test that fails when the defect it describes is
 * FIXED is not a regression test; it is a lock on the bug.
 *
 * `ZZ_SYNTHETIC_GAP_VAR` is outside the table for a reason nobody will ever
 * change: it is not a variable. What is being asserted here is the DETECTOR's
 * behaviour on a var-not-in-table, not the current membership of the table.
 */
const GAP_VAR = "ZZ_SYNTHETIC_GAP_VAR";

/**
 * The shape of the measurement that motivated this class: an interpolation
 * pinning exactly the value the schema would have supplied. To the
 * duplicate-detector it is invisible (the table does not name the var, so there
 * is nothing to compare); to the gap-detector it is a finding.
 */
const COMPOSE_WITH_UNTABLED_DEFAULT = `services:
  api:
    environment:
      - ${GAP_VAR}=\${${GAP_VAR}:-512}
`;

/** Schema-defaulted set as the gate would compute it — synthetic, so the case does not move with the schema. */
const SYNTHETIC_SCHEMA_DEFAULTED: ReadonlySet<string> = new Set([GAP_VAR]);

describe("readSchemaDefaults", () => {
  const { keys, defaulted } = readSchemaDefaults();

  it("finds the schema's key set", () => {
    // A handful of anchors rather than a count, so the test does not fail on
    // every unrelated env addition.
    expect(keys.has("MODULES")).toBe(true);
    expect(keys.has("LOG_LEVEL")).toBe(true);
    expect(keys.has("BETTER_AUTH_SECRET")).toBe(true);
  });

  it("detects a literal `.default(...)`", () => {
    expect(defaulted.has("LOG_LEVEL")).toBe(true);
    expect(defaulted.has("MODULES")).toBe(true);
  });

  it("detects a default that a `.transform()` pipe sits on top of", () => {
    // `SYSTEM_PROXIES: jsonEnv<unknown[]>("[]")` is
    // `z.string().default("[]").transform(…)`, so the top node is a pipe and
    // the default is on its `in` side. Reading only the top node under-reports
    // 22 variables of this shape.
    expect(defaulted.has("SYSTEM_PROXIES")).toBe(true);
    expect(defaulted.has("TRUST_PROXY")).toBe(true);
  });

  it("does not claim a default for a var that has none", () => {
    // Required, no default — boot fails without it.
    expect(keys.has("BETTER_AUTH_SECRET")).toBe(true);
    expect(defaulted.has("BETTER_AUTH_SECRET")).toBe(false);
    // Optional, no default.
    expect(defaulted.has("DATABASE_URL")).toBe(false);
  });

  it("agrees with the hand-maintained table on every var they both name", () => {
    // `CODE_DEFAULTS` is an independent, hand-written statement that a variable
    // HAS a schema default — and the gate's Class-1 check compares its recorded
    // VALUE against compose. An entry naming a variable the schema declares
    // WITHOUT a default is therefore a stale table entry, comparing compose
    // against a value nothing produces.
    //
    // Entries absent from the schema entirely are not an error and are excluded:
    // `OTEL_*` and the two `SIDECAR_MAX_*` vars are read straight from
    // `process.env` by the sidecar and by `@appstrate/module-observability`.
    const { keys, defaulted } = readSchemaDefaults();
    const claimedButNotDefaulted = Object.keys(CODE_DEFAULTS)
      .filter((name) => keys.has(name) && !defaulted.has(name))
      .sort();
    expect(claimedButNotDefaulted).toEqual([]);
  });
});

describe("findTableGaps", () => {
  const { defaulted } = readSchemaDefaults();

  it("catches a compose default for a schema-defaulted var missing from CODE_DEFAULTS", () => {
    // Precondition, and one no future edit can invalidate: the var is outside
    // the table, which is what makes it invisible to the duplicate check.
    expect(GAP_VAR in CODE_DEFAULTS).toBe(false);

    // The old gate's verdict on this file: clean. Asserting only the new half
    // would prove nothing — "no findings" is what the broken gate said too.
    expect(analyzeComposeDefaults(COMPOSE_WITH_UNTABLED_DEFAULT)).toEqual([]);

    // The new one's:
    expect(findTableGaps(COMPOSE_WITH_UNTABLED_DEFAULT, SYNTHETIC_SCHEMA_DEFAULTED)).toEqual([
      { line: 4, varName: GAP_VAR, yamlDefault: "512" },
    ]);
  });

  it("stays silent for a var the table already covers", () => {
    // `LOG_LEVEL` is in CODE_DEFAULTS, so the duplicate check owns it and the
    // gap check must not double-report.
    const content = `services:
  api:
    environment:
      - LOG_LEVEL=\${LOG_LEVEL:-info}
`;
    expect(findTableGaps(content, defaulted)).toEqual([]);
    expect(analyzeComposeDefaults(content).map((f) => f.kind)).toEqual(["duplicate"]);
  });

  it("stays silent for a var the schema gives no default to", () => {
    // A required secret pinned in compose is a different problem (and a
    // different gate); it is not a table gap. Synthetic on both sides: the var
    // is absent from the schema-defaulted set handed in, which is the whole
    // condition being tested.
    const content = `services:
  api:
    environment:
      - ZZ_SYNTHETIC_REQUIRED_VAR=\${ZZ_SYNTHETIC_REQUIRED_VAR:-hunter2}
`;
    expect(findTableGaps(content, SYNTHETIC_SCHEMA_DEFAULTED)).toEqual([]);
  });

  it("stays silent for a bare passthrough (no default pinned at all)", () => {
    const content = `services:
  api:
    environment:
      - ${GAP_VAR}
`;
    expect(findTableGaps(content, SYNTHETIC_SCHEMA_DEFAULTED)).toEqual([]);
  });
});

/**
 * Which Zod nodes count as "the schema supplies this value".
 *
 * Held against schemas built here rather than against
 * `packages/env/src/index.ts`, for the reason two of the cases below cannot be
 * written any other way: `.catch()` and `.prefault()` appear zero times in the
 * real schema today (measured 2026-08-26), so a test reading the real file
 * could only assert the forms already in use — the one thing never at risk.
 *
 * This describe replaces one that held SOURCE TEXT against a regex, and its two
 * helper-declaration cases (`const helper = …` vs `function helper(…) {}`) are
 * gone with it: they asserted that a text scan could find a helper's
 * declaration, which is a property of the parser and not of the schema. The
 * property they stood in for — a helper's internal default being seen — is
 * `SYSTEM_PROXIES` above, and it now holds regardless of how the helper is
 * written.
 */
describe("suppliesValue — which schemas produce a value the environment did not", () => {
  /**
   * A bare `z.string()` taken from the schema itself rather than from a `z`
   * import: `zod` is not a dependency of the root workspace this script lives
   * in, and building the cases off a real field means they are exercised
   * against the exact Zod build the gate introspects.
   */
  const bare = envSchema.shape.BETTER_AUTH_SECRET;

  it("sees a literal .default()", () => {
    expect(suppliesValue(bare.default("x"))).toBe(true);
  });

  it("sees .catch() and .prefault()", () => {
    // Both hand the parse a value the environment did not supply, so a compose
    // line pinning that value is the same #513 duplication a `.default()` is.
    expect(suppliesValue(bare.catch("info"))).toBe(true);
    expect(suppliesValue(bare.prefault("info"))).toBe(true);
  });

  it("sees a default underneath a .transform() pipe", () => {
    // The `boolEnv` / `jsonEnv` shape: the transform makes the top node a pipe.
    expect(suppliesValue(bare.default("false").transform((s) => s === "true"))).toBe(true);
  });

  it("does not claim a default for a plain optional or a bare type", () => {
    expect(suppliesValue(bare.optional())).toBe(false);
    expect(suppliesValue(bare)).toBe(false);
  });

  it("does NOT see a default supplied inside a transform body (documented hole)", () => {
    // Asserted so the limitation is a recorded decision rather than a surprise:
    // recognising this needs the transform body evaluated. A variable defaulted
    // only this way escapes the gate. `PLATFORM_API_URL` is the live instance of
    // the same shape — a pipe whose `in` side carries no default.
    expect(suppliesValue(bare.optional().transform((v) => v ?? "512"))).toBe(false);
    expect(suppliesValue(envSchema.shape.PLATFORM_API_URL)).toBe(false);
  });
});

/**
 * The gate as a PROCESS, against the failure the shared `git ls-files` helper
 * introduced: a tracked compose file missing from the working tree.
 *
 * Measured before the fix — `rm docker-compose.yml`, the root file this gate
 * exists for, then `bun scripts/verify-compose-defaults.ts`:
 *
 *     ✓ verify-compose-defaults: no duplicated env defaults across 8 compose files …
 *     EXIT=0
 *
 * The gate passed without reading it. The only trace anywhere was `9` becoming
 * `8` in a success line, which nobody diffs. The file is moved aside and
 * restored in a `finally`; it is a tracked file, so do not run this suite in
 * parallel with anything that reads the root compose file.
 */
describe("verify-compose-defaults as a process", () => {
  const REPO_ROOT = join(import.meta.dir, "..", "..");
  const COMPOSE = join(REPO_ROOT, "docker-compose.yml");

  function runGate(): { code: number; output: string } {
    const run = Bun.spawnSync({
      cmd: ["bun", "scripts/verify-compose-defaults.ts"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: run.exitCode ?? 1, output: run.stdout.toString() + run.stderr.toString() };
  }

  it("passes over the real repo", () => {
    const { code, output } = runGate();
    expect(code).toBe(0);
    expect(output).toContain("no duplicated env defaults");
  });

  it("fails when a tracked compose file is missing from the worktree", () => {
    const original = readFileSync(COMPOSE, "utf-8");
    try {
      rmSync(COMPOSE);
      const { code, output } = runGate();
      expect(code).not.toBe(0);
      expect(output).toContain("docker-compose.yml");
      expect(output).toMatch(/working tree does not have/);
      // And specifically NOT the cheerful past tense over a smaller set.
      expect(output).not.toContain("no duplicated env defaults");
    } finally {
      writeFileSync(COMPOSE, original);
    }
  });
});
