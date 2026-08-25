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
  findTableGaps,
  readSchemaDefaults,
} from "../verify-compose-defaults.ts";
import { analyzeComposeDefaults, CODE_DEFAULTS } from "../../apps/cli/src/lib/compose-defaults.ts";

/**
 * The exact compose fragment from the measurement that motivated this class.
 * `512` and `104857600` are the schema defaults for these two vars, so both
 * lines are textbook #513 duplications — and both were invisible.
 */
const COMPOSE_WITH_UNTABLED_DEFAULTS = `services:
  api:
    environment:
      - WORKSPACE_TMPFS_SIZE_MB=\${WORKSPACE_TMPFS_SIZE_MB:-512}
      - FILE_MAX_BYTES=\${FILE_MAX_BYTES:-104857600}
`;

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
  const { keys, defaulted } = readSchemaDefaults();

  it("catches a compose default for a schema-defaulted var missing from CODE_DEFAULTS", () => {
    // Precondition: these two are genuinely outside the table, which is what
    // makes them invisible to the duplicate check.
    expect("WORKSPACE_TMPFS_SIZE_MB" in CODE_DEFAULTS).toBe(false);
    expect("FILE_MAX_BYTES" in CODE_DEFAULTS).toBe(false);
    expect(defaulted.has("WORKSPACE_TMPFS_SIZE_MB")).toBe(true);
    expect(defaulted.has("FILE_MAX_BYTES")).toBe(true);

    // The old gate's verdict on this file: clean.
    expect(analyzeComposeDefaults(COMPOSE_WITH_UNTABLED_DEFAULTS)).toEqual([]);

    // The new one's:
    const gaps = findTableGaps(COMPOSE_WITH_UNTABLED_DEFAULTS, defaulted);
    expect(gaps.map((g) => g.varName).sort()).toEqual([
      "FILE_MAX_BYTES",
      "WORKSPACE_TMPFS_SIZE_MB",
    ]);
    expect(gaps.map((g) => g.yamlDefault).sort()).toEqual(["104857600", "512"]);
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
    // different gate); it is not a table gap.
    expect(keys.has("BETTER_AUTH_SECRET")).toBe(true);
    const content = `services:
  api:
    environment:
      - BETTER_AUTH_SECRET=\${BETTER_AUTH_SECRET:-hunter2}
`;
    expect(findTableGaps(content, defaulted)).toEqual([]);
  });

  it("stays silent for a bare passthrough (no default pinned at all)", () => {
    const content = `services:
  api:
    environment:
      - WORKSPACE_TMPFS_SIZE_MB
`;
    expect(findTableGaps(content, defaulted)).toEqual([]);
  });
});
