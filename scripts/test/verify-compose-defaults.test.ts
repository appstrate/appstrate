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
import {
  assertExtractorStillWorks,
  extractSchemaDefaults,
  findTableGaps,
  readSchemaDefaults,
} from "../verify-compose-defaults.ts";
import {
  analyzeComposeDefaults,
  CODE_DEFAULTS,
  SCHEMA_SOURCE,
} from "../../apps/cli/src/lib/compose-defaults.ts";

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

/**
 * The mutation the self-check could not see: the extractor returning NOTHING.
 *
 * Every other way this file can break is fail-closed — rename `envSchema` and
 * `extractSchemaDefaults` throws; move a helper below the schema and
 * `assertExtractorStillWorks` throws. Breaking the KEY ANCHOR was fail-OPEN:
 * `keys` and `defaulted` both come back empty, the intersection with
 * `CODE_DEFAULTS` is empty, nothing is "undetected", and the gate prints
 * `✓ … (0 schema defaults known …)` and exits 0 over every compose file.
 *
 * The mutation used here is the real one, not a strawman: re-indenting the real
 * schema from four spaces to two is what splitting `z.object({ … })` into
 * spread groups, or collapsing `z\n  .object({` to `z.object({`, does to every
 * key line.
 */
describe("assertExtractorStillWorks — vacuity floor", () => {
  const SCHEMA = readFileSync(join(import.meta.dir, "..", "..", SCHEMA_SOURCE), "utf-8");

  it("throws when the key anchor stops matching", () => {
    const reindented = SCHEMA.replace(/^ {4}/gm, "  ");
    const { keys, defaulted } = extractSchemaDefaults(reindented);

    // The mutation landed: this is the state the gate used to accept.
    expect(keys.size).toBe(0);
    expect(defaulted.size).toBe(0);

    expect(() => assertExtractorStillWorks(keys, defaulted)).toThrow(/below the floor/);
  });

  it("is silent on the real schema, which is far above the floor", () => {
    const { keys, defaulted } = extractSchemaDefaults(SCHEMA);
    // Not a pinned count — the floor is what is asserted, so this test does not
    // fail on every unrelated env addition or removal.
    expect(keys.size).toBeGreaterThanOrEqual(50);
    expect(() => assertExtractorStillWorks(keys, defaulted)).not.toThrow();
  });

  it("would have reported a real finding that the empty set hides", () => {
    // The half that proves the floor is worth having: with the extractor
    // working, this compose line IS a table gap; with it broken, the same line
    // reads as clean. "No findings" is what the broken gate said too.
    const compose = `services:
  api:
    environment:
      - WORKSPACE_TMPFS_SIZE_MB=\${WORKSPACE_TMPFS_SIZE_MB:-512}
`;
    const real = extractSchemaDefaults(SCHEMA);
    const broken = extractSchemaDefaults(SCHEMA.replace(/^ {4}/gm, "  "));
    expect(findTableGaps(compose, real.defaulted)).toEqual([
      { line: 4, varName: "WORKSPACE_TMPFS_SIZE_MB", yamlDefault: "512" },
    ]);
    expect(findTableGaps(compose, broken.defaulted)).toEqual([]);
  });
});

/**
 * Total collapse was the only mutation the floor could see, and it was also the
 * only one anybody had measured. PARTIAL collapse is the likelier shape — the
 * "object split into spread groups" refactor the gate's own failure text names
 * moves SOME keys out, not all of them — and a floor on the raw key count let
 * it through by a mile.
 *
 * Measured 2026-08-25 against the real schema: giving the first 44 key blocks
 * one extra level of indent gives 55 keys / 34 defaults instead of 99 / 67.
 * 33 defaults gone, `keys.size` still comfortably over the old floor of 50, the
 * self-check silent, a real table-gap finding gone with them, and the green tick
 * printed. The companion `undetected` check cannot cover for it either: it
 * filters on `keys.has(name)`, so every key the extractor loses leaves that
 * check quieter rather than louder.
 *
 * So one of the three floors sits on `CODE_DEFAULTS ∩ keys` — a set that
 * degrades one variable at a time — and this is the case that proves the
 * difference. The other two (`MIN_SCHEMA_KEYS`, `MIN_CLASS3_POPULATION`) have
 * their own describes below; each has a mutation only it can catch.
 */
describe("assertExtractorStillWorks — partial degradation", () => {
  const SCHEMA = readFileSync(join(import.meta.dir, "..", "..", SCHEMA_SOURCE), "utf-8");

  /** One extra indent level on the first `count` key blocks, leaving the rest. */
  function degradeFirstKeys(source: string, count: number): string {
    const lines = source.split("\n");
    const keyLines: number[] = [];
    lines.forEach((line, i) => {
      if (/^ {4}[A-Z][A-Z0-9_]*:/.test(line)) keyLines.push(i);
    });
    if (keyLines.length <= count) {
      throw new Error(`schema has ${keyLines.length} keys — too few to degrade only ${count}.`);
    }
    const boundary = keyLines[count] ?? lines.length;
    return lines.map((l, i) => (i < boundary && /^ {4}/.test(l) ? `  ${l}` : l)).join("\n");
  }

  it("throws when half the keys stop matching the anchor", () => {
    const { keys, defaulted } = extractSchemaDefaults(degradeFirstKeys(SCHEMA, 44));

    // The mutation landed AND stayed well clear of a raw-count floor: this is
    // the exact state the previous `keys.size < 50` check waved through.
    expect(keys.size).toBe(55);
    expect(defaulted.size).toBe(34);
    expect(keys.size).toBeGreaterThan(50);

    expect(() => assertExtractorStillWorks(keys, defaulted)).toThrow(/below the floor/);
  });

  it("loses real table-gap findings in exactly that state", () => {
    // The half that proves the floor is worth having. `CONNECT_SESSION_TTL_MS`
    // is one of the 14 schema-defaulted variables `CODE_DEFAULTS` does not
    // name, which is precisely what makes a compose line pinning it a Class-3
    // finding — and it sits in the degraded region.
    const compose = `services:
  api:
    environment:
      - CONNECT_SESSION_TTL_MS=\${CONNECT_SESSION_TTL_MS:-3600000}
`;
    const real = extractSchemaDefaults(SCHEMA);
    const degraded = extractSchemaDefaults(degradeFirstKeys(SCHEMA, 44));
    expect(findTableGaps(compose, real.defaulted)).toEqual([
      { line: 4, varName: "CONNECT_SESSION_TTL_MS", yamlDefault: "3600000" },
    ]);
    expect(findTableGaps(compose, degraded.defaulted)).toEqual([]);
  });

  it("still accepts the real schema, so the floor has headroom", () => {
    const { keys, defaulted } = extractSchemaDefaults(SCHEMA);
    const covered = Object.keys(CODE_DEFAULTS).filter((name) => keys.has(name));
    // 53 of 58 at the time of writing; the 5 outside are read from process.env
    // by the sidecar and module-observability and are not schema keys at all.
    expect(covered.length).toBeGreaterThanOrEqual(45);
    expect(() => assertExtractorStillWorks(keys, defaulted)).not.toThrow();
  });
});

/**
 * The two floors the `CODE_DEFAULTS ∩ keys` one cannot stand in for.
 *
 * That floor counts the table entries the extractor still recognises — which is
 * exactly the set `findTableGaps` throws away: it opens with
 * `if (match.varName in CODE_DEFAULTS) continue;`. So the instrument added to
 * protect the Class-3 check measured its COMPLEMENT, and it also replaced the
 * raw `keys.size` floor that used to sit beside it. Both gaps are measured, and
 * each mutation below is caught by exactly one floor — remove that floor and
 * the case goes green.
 *
 * The mutation is the same real one used above (one extra indent level, the
 * "object split into spread groups" refactor), applied to a CHOSEN subset of
 * key blocks rather than to a prefix. Choosing the subset is what makes each
 * case discriminate: a mutation that degrades everything trips every floor and
 * proves none of them.
 */
describe("assertExtractorStillWorks — the floors beside the table intersection", () => {
  const SCHEMA = readFileSync(join(import.meta.dir, "..", "..", SCHEMA_SOURCE), "utf-8");
  const REAL = extractSchemaDefaults(SCHEMA);

  /**
   * One extra indent level on every key block whose name `pick` selects.
   *
   * A key line at five spaces no longer matches the anchor, and its body no
   * longer dedents far enough to close the PREVIOUS key — so the block is
   * absorbed into its predecessor, which is precisely what the real refactor
   * does to it.
   */
  function degrade(source: string, pick: (name: string) => boolean): string {
    const out: string[] = [];
    let shifting = false;
    for (const line of source.split("\n")) {
      const key = /^ {4}([A-Z][A-Z0-9_]*):/.exec(line);
      if (key?.[1]) shifting = pick(key[1]);
      else if (shifting && /^ {0,3}\S/.test(line)) shifting = false;
      out.push(shifting ? ` ${line}` : line);
    }
    return out.join("\n");
  }

  const tableIntersection = (keys: Set<string>): number =>
    Object.keys(CODE_DEFAULTS).filter((name) => keys.has(name)).length;
  const class3Population = (defaulted: Set<string>): string[] =>
    [...defaulted].filter((name) => !(name in CODE_DEFAULTS)).sort();

  it("throws when a fifth of the raw key count disappears, leaving both other floors clear", () => {
    // MIN_SCHEMA_KEYS, restored. Degrading only the key blocks that are neither
    // in CODE_DEFAULTS nor defaulted leaves the intersection and the Class-3
    // population untouched, so this case is invisible to the two floors that
    // survived the round which removed the raw count.
    const { keys, defaulted } = extractSchemaDefaults(
      degrade(SCHEMA, (name) => !(name in CODE_DEFAULTS) && !REAL.defaulted.has(name)),
    );
    expect(keys.size).toBe(67);
    expect(tableIntersection(keys)).toBe(53);
    expect(class3Population(defaulted)).toHaveLength(14);
    // Both other instruments are silent about it, by construction:
    expect(tableIntersection(keys)).toBeGreaterThanOrEqual(45);
    expect(Object.keys(CODE_DEFAULTS).filter((n) => keys.has(n) && !defaulted.has(n))).toEqual([]);

    expect(() => assertExtractorStillWorks(keys, defaulted)).toThrow(
      /found only 67 schema key\(s\), below the floor of 80/,
    );
  });

  it("throws when the Class-3 population collapses, leaving both other floors clear", () => {
    // MIN_CLASS3_POPULATION. Degrading ONLY the 14 schema-defaulted variables
    // CODE_DEFAULTS does not name takes away 100% of what Class 3 can report
    // while `keys.size` stays at 85 and the intersection never moves — the
    // shape neither other floor can see.
    const { keys, defaulted } = extractSchemaDefaults(
      degrade(SCHEMA, (name) => !(name in CODE_DEFAULTS) && REAL.defaulted.has(name)),
    );
    expect(keys.size).toBe(85);
    expect(tableIntersection(keys)).toBe(53);
    expect(class3Population(defaulted)).toHaveLength(3);
    expect(keys.size).toBeGreaterThanOrEqual(80);
    expect(tableIntersection(keys)).toBeGreaterThanOrEqual(45);

    expect(() => assertExtractorStillWorks(keys, defaulted)).toThrow(
      /Class-3 check has only 3 variable\(s\) left to report on/,
    );
  });

  it("names the legitimate cause of a shrink, not only the suspicious one", () => {
    // The failure text this replaces said "do NOT lower this floor" — but the
    // sanctioned fix for a Class-3 finding is to add the variable to
    // CODE_DEFAULTS, which shrinks this population by design. A message that
    // forbids the correct action sends the reader to the wrong edit.
    const { keys, defaulted } = extractSchemaDefaults(
      degrade(SCHEMA, (name) => !(name in CODE_DEFAULTS) && REAL.defaulted.has(name)),
    );
    const message = (() => {
      try {
        assertExtractorStillWorks(keys, defaulted);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toMatch(/CODE_DEFAULTS legitimately GREW/);
    expect(message).toMatch(/LOWER MIN_CLASS3_POPULATION/);
    expect(message).toMatch(/extractor lost the defaults/);
  });

  it("was silent, and lost a real finding, in the state that motivated all this", () => {
    // The measured attack, reproduced whole: degrade every NON-table key block.
    // `CODE_DEFAULTS ∩ keys` — the only floor there was — does not move by a
    // single entry, and `undetected` stays empty, because both are computed
    // over the set Class 3 skips.
    const degraded = extractSchemaDefaults(degrade(SCHEMA, (name) => !(name in CODE_DEFAULTS)));
    expect(degraded.keys.size).toBe(53);
    expect(degraded.defaulted.size).toBe(53);
    expect(tableIntersection(degraded.keys)).toBe(53);
    expect(tableIntersection(degraded.keys)).toBeGreaterThanOrEqual(45);
    expect(
      Object.keys(CODE_DEFAULTS).filter((n) => degraded.keys.has(n) && !degraded.defaulted.has(n)),
    ).toEqual([]);
    expect(class3Population(degraded.defaulted)).toEqual([]);

    // …and a real Class-3 finding on a real compose line goes with it.
    const compose = `services:
  api:
    environment:
      - WORKSPACE_TMPFS_SIZE_MB=\${WORKSPACE_TMPFS_SIZE_MB:-512}
`;
    expect(findTableGaps(compose, REAL.defaulted)).toHaveLength(1);
    expect(findTableGaps(compose, degraded.defaulted)).toEqual([]);

    // Two of the three floors now refuse it. Neither of them existed, in this
    // form, when the state above measured GATE EXIT=0.
    expect(() => assertExtractorStillWorks(degraded.keys, degraded.defaulted)).toThrow(
      /below the floor of 80/,
    );
  });

  it("leaves headroom on the real schema for all three floors", () => {
    // Stated headroom, so an ordinary env-var change never turns this red:
    // keys 99 vs 80, intersection 53 vs 45, Class-3 population 14 vs 8.
    expect(REAL.keys.size).toBeGreaterThanOrEqual(80 + 15);
    expect(tableIntersection(REAL.keys)).toBeGreaterThanOrEqual(45 + 5);
    expect(class3Population(REAL.defaulted).length).toBeGreaterThanOrEqual(8 + 4);
    expect(() => assertExtractorStillWorks(REAL.keys, REAL.defaulted)).not.toThrow();
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
