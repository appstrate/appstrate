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
  countErrorRules,
  KNOWN_IGNORED,
  measureRuleCoverage,
  MIN_ERROR_RULES_PER_FILE,
  partitionIgnored,
  populationOf,
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
 * has the same green-over-nothing failure. Two measured doors, both giving
 * GATE EXIT=0:
 *
 *   - 2026-08-25 — appending one config object that sets all 70 rules enabled
 *     for a `.ts` file to `"off"`, plus a real seeded error, over 2206 files;
 *   - 2026-08-26 — the same 70 rules set to `"warn"` instead:
 *     `712 problems (0 errors, 712 warnings)`, exit 0.
 *
 * The second is why `countErrorRules` requires severity 2 rather than "not
 * off", and why the invocation carries `--max-warnings 0`.
 */
describe("countErrorRules", () => {
  it("counts an error rule once, whatever form its severity takes", () => {
    expect(countErrorRules({ a: "error", b: 2, c: ["error", { allow: [] }], d: [2] })).toBe(4);
  });

  it("does not count the rules a config explicitly turns off", () => {
    // `tseslint.configs.recommended` alone sets dozens of rules to `"off"`
    // explicitly, so counting KEYS would score a disable-everything config as
    // fully covered.
    expect(countErrorRules({ a: "off", b: 0, c: ["off"], d: "error" })).toBe(1);
    expect(countErrorRules({})).toBe(0);
    expect(countErrorRules(undefined)).toBe(0);
  });

  it("does not count a rule downgraded to a warning", () => {
    // The measured `0 errors, 712 warnings` pass, in miniature. A warning does
    // not fail eslint's exit code on its own, so counting `"warn"` as coverage
    // scored a repo whose every rule had been defanged as fully covered.
    expect(countErrorRules({ a: "warn", b: 1, c: ["warn", { x: 1 }], d: [1] })).toBe(0);
    expect(countErrorRules({ a: "warn", b: "error" })).toBe(1);
  });
});

describe("populationOf", () => {
  it("groups by top-level directory, with a bucket for the repo root", () => {
    expect(populationOf("packages/core/src/naming.ts")).toBe("packages");
    expect(populationOf("apps/web/src/main.tsx")).toBe("apps");
    expect(populationOf("eslint.config.mjs")).toBe(".");
  });
});

describe("assertRuleCoverage", () => {
  const ok = (file: string): [string, number] => [file, MIN_ERROR_RULES_PER_FILE];

  it("accepts a measurement at or above the floor", () => {
    expect(() =>
      assertRuleCoverage(new Map([ok("apps/a.ts"), ok("packages/b.ts"), ok("scripts/c.ts")])),
    ).not.toThrow();
  });

  it("refuses a single file whose rules have been switched off", () => {
    // The floor's subject is every file, so ONE file dropping below it is
    // enough — there is no sentinel to keep intact.
    const measured = new Map([ok("apps/a.ts"), ["packages/b.ts", 0] as [string, number]]);
    expect(() => assertRuleCoverage(measured)).toThrow(/fewer error-severity rules/);
    expect(() => assertRuleCoverage(measured)).toThrow(/packages\/: 1 file\(s\) under the floor/);
  });

  it("reports a whole disabled population as one line, naming its worst file", () => {
    // The `{ files: ["packages/**"], rules: { …off } }` shape: hundreds of
    // files at once. Printing them individually would bury the finding.
    const measured = new Map<string, number>([ok("apps/a.ts")]);
    for (let i = 0; i < 300; i++) measured.set(`packages/p${i}/x.ts`, i === 7 ? 1 : 40);
    const message = (() => {
      try {
        assertRuleCoverage(measured);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toMatch(/300 of the 301 file\(s\)/);
    expect(message).toMatch(
      /packages\/: 300 file\(s\) under the floor, worst packages\/p7\/x\.ts at 1 rule\(s\)/,
    );
    expect(message).not.toMatch(/apps\//);
  });

  it("refuses a measurement of nothing at all", () => {
    // An empty map is the vacuous pass one level up: nothing measured, nothing
    // under the floor, gate green.
    expect(() => assertRuleCoverage(new Map())).toThrow(/measurement is empty/);
  });
});

describe("the live eslint config's rule coverage", () => {
  it("clears the floor for EVERY lintable file, with the headroom the comment claims", async () => {
    // The real instrument against the real config, over the real population —
    // the same list `scripts/lint.ts` measures, not a chosen subset.
    const api = new ESLint({ cwd: REPO_ROOT });
    const { lintable } = await partitionIgnored(
      trackedIndexFiles(SOURCE_GLOBS, "lintable file"),
      (file) => api.isPathIgnored(file),
    );
    const measured = await measureRuleCoverage(api, lintable);
    expect(measured.size).toBe(lintable.length);
    expect(() => assertRuleCoverage(measured)).not.toThrow();

    // The population really does span the repo — a measurement covering one
    // directory would satisfy the assertion above and prove nothing.
    const populations = new Set([...measured.keys()].map(populationOf));
    expect(populations.size).toBeGreaterThanOrEqual(5);
    expect(populations).toContain("packages");
    expect(populations).toContain("scripts");

    // Headroom, stated: measured 2026-08-26 the repo-wide minimum is 63
    // against a floor of 50.
    const min = Math.min(...measured.values());
    expect(min).toBeGreaterThan(MIN_ERROR_RULES_PER_FILE);
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

  /** Every rule the live config sets above "off" for `file`. */
  async function enabledRulesFor(file: string): Promise<string[]> {
    const api = new ESLint({ cwd: REPO_ROOT });
    const config = (await api.calculateConfigForFile(file)) as
      { rules?: Record<string, unknown> } | undefined;
    return Object.entries(config?.rules ?? {})
      .filter(([, value]) => {
        const severity = Array.isArray(value) ? value[0] : value;
        return severity !== 0 && severity !== "off" && severity !== undefined;
      })
      .map(([name]) => name);
  }

  /**
   * A `.ts` file under `packages/`, taken from the tracked list rather than
   * named — this test is ABOUT not hardcoding paths, so hardcoding one here
   * would be the same mistake one level down.
   */
  function aPackagesSource(): string {
    const file = trackedIndexFiles(SOURCE_GLOBS, "lintable file").find(
      (f) => f.startsWith("packages/") && f.endsWith(".ts"),
    );
    if (!file) throw new Error("no tracked `packages/**/*.ts` — this test cannot work.");
    return file;
  }

  it("fails when rules are switched off for a scope no sentinel file covers", async () => {
    // DEFECT 1, run for real. The floors this replaces named three files —
    // `apps/api/src/index.ts`, `apps/web/src/main.tsx`, `eslint.config.mjs` —
    // and one config object scoped AROUND all three walked straight past them.
    // Measured 2026-08-26 with a real seeded `any` in
    // `packages/core/src/naming.ts`: GATE EXIT=0, ~640 tracked sources
    // (`packages/` plus every gate script, this repo's lint entrypoint
    // included) linted at zero rules.
    //
    // The mutation deliberately leaves all three former sentinels untouched.
    // Under a per-sentinel floor this case is green; only a floor over the
    // whole lintable population can see it.
    const allOff = JSON.stringify(
      Object.fromEntries((await enabledRulesFor(aPackagesSource())).map((n) => [n, "off"])),
    );
    const { code, output } = runGateWith((source) =>
      source.replace(
        "  eslintConfigPrettier,\n);",
        `  eslintConfigPrettier,\n  { files: ["packages/**/*.{ts,tsx}", "scripts/**/*.ts"], rules: ${allOff} },\n);`,
      ),
    );
    expect(code).not.toBe(0);
    expect(output).toMatch(/fewer error-severity rules than this repo's floor/);
    // …and it says WHERE, which is what makes the report actionable.
    expect(output).toMatch(/packages\/: \d+ file\(s\) under the floor/);
    expect(output).toMatch(/scripts\/: \d+ file\(s\) under the floor/);
  });

  it("fails when rules are downgraded to warnings", async () => {
    // DEFECT 2, static half. `"warn"` is not `"off"`, so a count of
    // "everything not off" was unmoved by this and the gate passed with
    // `712 problems (0 errors, 712 warnings)` — measured 2026-08-26.
    //
    // The plugin has to be re-declared: unlike `"off"`, a rule set to `"warn"`
    // makes eslint resolve the plugin behind it.
    const enabled = await enabledRulesFor(aPackagesSource());
    const allWarn = JSON.stringify(Object.fromEntries(enabled.map((n) => [n, "warn"])));
    const { code, output } = runGateWith((source) =>
      source.replace(
        "  eslintConfigPrettier,\n);",
        `  eslintConfigPrettier,\n  { files: ["**/*.ts"], plugins: { "@typescript-eslint": tseslint.plugin }, rules: ${allWarn} },\n);`,
      ),
    );
    expect(code).not.toBe(0);
    expect(output).toMatch(/fewer error-severity rules than this repo's floor/);
  });

  it("fails on a warning that fires, however few", () => {
    // DEFECT 2, runtime half — and the only case that discriminates
    // `--max-warnings 0` on its own. The rule-count floor above cannot see
    // this: the config still enables its full complement of ERROR rules, and
    // one extra `"warn"` rule is added on top. Without the flag eslint prints
    // the finding and exits 0, so `bun run check` stays green over it.
    //
    // `no-warning-comments` is a core rule (no plugin to resolve) pointed at
    // the SPDX header every file in this repo carries, so it is guaranteed to
    // fire without seeding anything into a tracked source.
    //
    // This is the one case here that has to lint the whole repo before it can
    // fail, so it is the slow one (~20 s): the mutation changes the config
    // hash, which invalidates `--cache`.
    const { code, output } = runGateWith((source) =>
      source.replace(
        "  eslintConfigPrettier,\n);",
        `  eslintConfigPrettier,\n  { files: ["scripts/lint.ts"], rules: { "no-warning-comments": ["warn", { terms: ["SPDX"], location: "anywhere" }] } },\n);`,
      ),
    );
    expect(code).not.toBe(0);
    expect(output).toMatch(/Unexpected 'SPDX' comment/);
    expect(output).toMatch(/warning|max-warnings/i);
    // Measured 2026-08-26: 20.8 s, against bunfig's 15 s default. The other
    // subprocess cases here fail before eslint is spawned and take ~1 s.
  }, 120_000);
});
