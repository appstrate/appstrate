// SPDX-License-Identifier: Apache-2.0

/**
 * `bun run lint` must not be able to report success over files ESLint never
 * had a rule for.
 *
 * The version of `scripts/lint.ts` these tests were written against passed
 * `--no-warn-ignored`, to silence one warning line about the generated
 * `apps/web/src/api/schema.d.ts`. That flag does not silence one path, it
 * silences the mechanism — the ONLY signal a caller gets that the config has
 * un-scoped something. Measured 2026-08-25 by adding `"apps/**"` to the
 * `ignores` array in `eslint.config.mjs`: `bun scripts/lint.ts` handed eslint
 * 2204 paths, got an empty result for ~2100 of them, printed ZERO bytes and
 * exited 0. `bun run check` was green over an unlinted API and SPA.
 *
 * So the ignored set is asserted rather than muted, and both directions of
 * drift are held below: a widened `ignores`, and a stale entry that has stopped
 * excluding anything (the `deadExclusions` rule the sibling gate
 * `scripts/lint-manifest-casing.ts` already applies to its own exclusions).
 */

import { describe, it, expect } from "bun:test";
import { ESLint } from "eslint";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertIgnoredSetIsExact,
  assertRuleCoverage,
  countEnabledRules,
  KNOWN_IGNORED,
  measureRuleCoverage,
  partitionIgnored,
  RULE_COVERAGE_FLOORS,
} from "../lint.ts";
import { SOURCE_GLOBS, trackedIndexFiles } from "../lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("assertIgnoredSetIsExact", () => {
  it("accepts exactly the documented set", () => {
    expect(() => assertIgnoredSetIsExact([...KNOWN_IGNORED])).not.toThrow();
  });

  it("throws when `ignores` swallows files nobody documented", () => {
    // The `"apps/**"` mutation, in miniature: files eslint reports NOTHING
    // about, which under the old flag produced no output and exit 0.
    expect(() =>
      assertIgnoredSetIsExact([...KNOWN_IGNORED, "apps/api/src/index.ts", "apps/web/src/main.tsx"]),
    ).toThrow(/2 tracked file\(s\) are excluded by `ignores`/);
  });

  it("throws when a documented entry has stopped excluding anything", () => {
    // The other direction, and the one a stale list hides: an entry that
    // matches nothing today silently excuses whatever lands at that path next.
    expect(() => assertIgnoredSetIsExact([])).toThrow(/no longer match an ignored tracked file/);
  });
});

describe("partitionIgnored", () => {
  const files = ["a.ts", "b.ts", "c.ts"];

  it("keeps the ignored files out of the list handed to eslint", async () => {
    const { lintable, ignored } = await partitionIgnored(files, (f) => f === "b.ts");
    expect(lintable).toEqual(["a.ts", "c.ts"]);
    expect(ignored).toEqual(["b.ts"]);
  });

  it("surfaces a config that ignores everything as an empty lintable set", async () => {
    const { lintable, ignored } = await partitionIgnored(files, () => true);
    expect(lintable).toEqual([]);
    expect(ignored).toEqual(files);
    // …which the assertion then refuses, rather than eslint being handed
    // nothing and exiting 0.
    expect(() => assertIgnoredSetIsExact(ignored)).toThrow();
  });
});

describe("the live eslint config", () => {
  it("ignores exactly the tracked files KNOWN_IGNORED documents", async () => {
    // The wiring test: the two pure halves above can both be right while the
    // gate reads the wrong config. This one asks the real `eslint.config.mjs`
    // about the real tracked file list.
    const api = new ESLint({ cwd: REPO_ROOT });
    const { ignored } = await partitionIgnored(
      trackedIndexFiles(SOURCE_GLOBS, "lintable file"),
      (file) => api.isPathIgnored(file),
    );
    expect(ignored).toEqual([...KNOWN_IGNORED]);
  });
});

/**
 * The ignored-set assertion answers "does eslint have a config for this file?".
 * It cannot answer "does that config say anything?", and the second question
 * has the same green-over-nothing failure. Measured 2026-08-25: appending one
 * config object that sets all 70 rules enabled for a `.ts` file to `"off"`,
 * plus a real seeded error, gave GATE EXIT=0 over 2206 files.
 */
describe("countEnabledRules", () => {
  it("counts a rule once, whatever form its severity takes", () => {
    expect(
      countEnabledRules({
        a: "error",
        b: "warn",
        c: 1,
        d: ["error", { allow: [] }],
      }),
    ).toBe(4);
  });

  it("does not count the rules a config explicitly turns off", () => {
    // The whole point. `tseslint.configs.recommended` alone sets dozens of
    // rules to `"off"` explicitly, so counting KEYS would score a
    // disable-everything config as fully covered — which is the mutation.
    expect(countEnabledRules({ a: "off", b: 0, c: ["off"], d: "error" })).toBe(1);
    expect(countEnabledRules({})).toBe(0);
    expect(countEnabledRules(undefined)).toBe(0);
  });
});

describe("assertRuleCoverage", () => {
  it("accepts a measurement at or above every floor", () => {
    const measured = new Map(RULE_COVERAGE_FLOORS.map(({ file, min }) => [file, min]));
    expect(() => assertRuleCoverage(measured)).not.toThrow();
  });

  it("refuses a dialect whose rules have been switched off", () => {
    const measured = new Map(RULE_COVERAGE_FLOORS.map(({ file, min }) => [file, min]));
    const victim = RULE_COVERAGE_FLOORS[0];
    if (!victim) throw new Error("RULE_COVERAGE_FLOORS is empty — the gate would check nothing.");
    measured.set(victim.file, 0);
    expect(() => assertRuleCoverage(measured)).toThrow(/0 enabled rule\(s\), floor/);
  });

  it("refuses a dialect eslint resolved no config for at all", () => {
    // A missing entry is `undefined`, not zero. Reading it as "no floor to
    // check" would make a file dropping out of the config the quietest possible
    // outcome.
    expect(() => assertRuleCoverage(new Map())).toThrow(/fewer enabled rules/);
  });
});

describe("the live eslint config's rule coverage", () => {
  it("clears every floor, with the headroom the comment claims", async () => {
    // The real instrument against the real config: floors are a floor, so this
    // also documents that ordinary rule churn has room before it goes red.
    const api = new ESLint({ cwd: REPO_ROOT });
    const measured = await measureRuleCoverage(api);
    expect(() => assertRuleCoverage(measured)).not.toThrow();
    for (const { file, min } of RULE_COVERAGE_FLOORS) {
      expect(measured.get(file) ?? 0).toBeGreaterThanOrEqual(min);
    }
  });
});

/**
 * The two describes above, and the one at the top of this file, all hold pure
 * helpers. None of them runs the gate, and that gap was measured: deleting the
 * `assertIgnoredSetIsExact(ignored)` call from `scripts/lint.ts:main` left every
 * test in this file passing. The wiring was asserted only by tests that
 * re-implement the wiring.
 *
 * So these two run `bun scripts/lint.ts` as a subprocess against a MUTATED
 * `eslint.config.mjs` and require it to fail. Both mutations are ones the gate
 * must catch before it spawns eslint, so the subprocess exits in about a second
 * rather than linting 2200 files.
 *
 * The config file is restored in a `finally`. It is a tracked file being
 * rewritten in place, so do not run this suite in parallel with anything else
 * that reads `eslint.config.mjs`.
 */
describe("scripts/lint.ts as a process", () => {
  const CONFIG = join(REPO_ROOT, "eslint.config.mjs");

  function runGateWith(mutate: (source: string) => string): { code: number; output: string } {
    const original = readFileSync(CONFIG, "utf8");
    const mutated = mutate(original);
    if (mutated === original) {
      throw new Error("the mutation matched nothing — eslint.config.mjs has been restructured.");
    }
    try {
      writeFileSync(CONFIG, mutated);
      const run = Bun.spawnSync({
        cmd: ["bun", "scripts/lint.ts"],
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: run.exitCode ?? 1,
        output: run.stdout.toString() + run.stderr.toString(),
      };
    } finally {
      writeFileSync(CONFIG, original);
    }
  }

  it("fails when `ignores` silently widens", () => {
    // The `"apps/**"` measurement, run for real: under `--no-warn-ignored` an
    // added `ignores` entry printed zero bytes and exited 0 over an unlinted
    // API and SPA.
    //
    // `packages/**` rather than `apps/**` on purpose. An ignored file resolves
    // to ZERO rules, so ignoring `apps/**` also trips the rule-coverage floor
    // below (its subject files live there) and this case would be proven by the
    // wrong assertion. `packages/**` is ~700 tracked sources that no floor
    // looks at, so only the ignored-set assertion can catch it.
    const { code, output } = runGateWith((source) =>
      source.replace('      ".claude/",\n', '      ".claude/",\n      "packages/**",\n'),
    );
    expect(code).not.toBe(0);
    expect(output).toMatch(/tracked file\(s\) are excluded by `ignores`/);
  });

  it("fails when the config stops enabling rules", async () => {
    // Every rule the live config enables for the floors' own subject files,
    // turned off by one appended config object — the measured GATE EXIT=0.
    const api = new ESLint({ cwd: REPO_ROOT });
    const enabled = new Set<string>();
    for (const { file } of RULE_COVERAGE_FLOORS) {
      const config = (await api.calculateConfigForFile(file)) as
        { rules?: Record<string, unknown> } | undefined;
      for (const [name, value] of Object.entries(config?.rules ?? {})) {
        const severity = Array.isArray(value) ? value[0] : value;
        if (severity !== 0 && severity !== "off" && severity !== undefined) enabled.add(name);
      }
    }
    expect(enabled.size).toBeGreaterThan(50);
    const allOff = JSON.stringify(Object.fromEntries([...enabled].map((n) => [n, "off"])));

    const { code, output } = runGateWith((source) =>
      source.replace(
        "  eslintConfigPrettier,\n);",
        `  eslintConfigPrettier,\n  { files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"], rules: ${allOff} },\n);`,
      ),
    );
    expect(code).not.toBe(0);
    expect(output).toMatch(/fewer enabled rules than this repo's floor/);
  });
});
