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
import {
  assertExtractorStillWorks,
  extractSchemaDefaults,
  findTableGaps,
  readSchemaDefaults,
} from "../verify-compose-defaults.ts";
import { analyzeComposeDefaults, CODE_DEFAULTS } from "../../apps/cli/src/lib/compose-defaults.ts";

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

  it("detects a default applied by a discovered helper (jsonEnv / boolEnv)", () => {
    // `SYSTEM_PROXIES: jsonEnv<unknown[]>("[]")` — no literal `.default(` on the
    // line. A literal-only scan missed 16 variables of this shape.
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
    // The gate runs this before trusting the extractor; running it here too
    // means the schema's style drifting away from the parser fails a test
    // rather than silently shrinking coverage.
    expect(() => assertExtractorStillWorks(keys, defaulted)).not.toThrow();
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
 * The defaulting forms the extractor recognises, held against a SYNTHETIC
 * schema rather than `packages/env/src/index.ts`.
 *
 * Two of the four cases below cannot be written any other way: `.catch(` and a
 * `function`-declared helper appear zero times in the real schema today
 * (measured 2026-08-25), so a test reading the real file could only assert that
 * the extractor handles the styles already in use — which is the one thing
 * never at risk. These are the styles a future edit might introduce, and this
 * is where they get their assertion.
 */
describe("extractSchemaDefaults — recognised defaulting forms", () => {
  /** Wraps key blocks in the minimal shape the extractor anchors on. */
  const schema = (helpers: string, keyBlocks: string): string =>
    `${helpers}
const envSchema = z
  .object({
${keyBlocks}
  })
`;

  it("detects a literal .default()", () => {
    const { keys, defaulted } = extractSchemaDefaults(
      schema("", `    A_VAR: z.string().default("x"),`),
    );
    expect(keys.has("A_VAR")).toBe(true);
    expect(defaulted.has("A_VAR")).toBe(true);
  });

  it("detects .catch() and .prefault() as defaulting", () => {
    const { defaulted } = extractSchemaDefaults(
      schema(
        "",
        `    A_VAR: z.string().catch("info"),
    B_VAR: z.string().prefault("info"),`,
      ),
    );
    // Both hand the parse a value the environment did not supply, so a compose
    // line pinning that value is the same #513 duplication a `.default()` is.
    expect(defaulted.has("A_VAR")).toBe(true);
    expect(defaulted.has("B_VAR")).toBe(true);
  });

  it("discovers an arrow-const helper that defaults internally", () => {
    const helpers = `const boolEnv = (d: string) =>
  z
    .string()
    .default(d);
`;
    const { defaulted } = extractSchemaDefaults(schema(helpers, `    A_VAR: boolEnv("false"),`));
    expect(defaulted.has("A_VAR")).toBe(true);
  });

  it("discovers a `function`-declared helper that defaults internally", () => {
    // The form the extractor was blind to: it only scanned `const NAME =`, so a
    // helper written as a function declaration made every variable using it
    // read as un-defaulted, and a compose file pinning its default passed.
    const helpers = `function boolEnv(d: string) {
  return z.string().default(d);
}
`;
    const { defaulted } = extractSchemaDefaults(schema(helpers, `    A_VAR: boolEnv("false"),`));
    expect(defaulted.has("A_VAR")).toBe(true);
  });

  it("does not claim a default for a plain optional", () => {
    const { keys, defaulted } = extractSchemaDefaults(
      schema("", `    A_VAR: z.string().optional(),`),
    );
    expect(keys.has("A_VAR")).toBe(true);
    expect(defaulted.has("A_VAR")).toBe(false);
  });

  it("does NOT see a default supplied inside a transform (documented hole)", () => {
    // Asserted so the limitation is a recorded decision rather than a surprise:
    // recognising this needs the transform body evaluated. A variable defaulted
    // only this way escapes the gate.
    const { defaulted } = extractSchemaDefaults(
      schema("", `    A_VAR: z.string().optional().transform((v) => v ?? "512"),`),
    );
    expect(defaulted.has("A_VAR")).toBe(false);
  });
});
