// SPDX-License-Identifier: Apache-2.0

/**
 * Every builder of a Pi model record either spreads `PLATFORM_MODEL_COMPAT` or
 * is listed here as exempt WITH its reason.
 *
 * This gate exists because the rule it enforces was previously a convention.
 * Three sites spelled `supportsLongCacheRetention: false` by hand, each under
 * its own twenty-line comment, and two of the five builders carried neither —
 * one of them `resolvePresetModel`, which is platform-billed. Nothing recorded
 * which two, or why. A convention that has to be remembered at each new
 * construction site is exactly what silently under-billed the org.
 *
 * The list is checked in BOTH directions: a builder that appears in the source
 * and not here fails, and an entry here that matches no real builder fails too,
 * so it cannot decay into a record of code that no longer exists.
 *
 * "Every builder" is meant literally, which is why the scan set is derived from
 * the tree rather than typed out. A hardcoded file list makes the gate blind in
 * exactly the direction it is supposed to watch: a sixth builder in a fifth file
 * is invisible to it, and that is the same "remember the convention at each new
 * construction site" failure the constant was created to end. Same reasoning for
 * the value assertion below — a gate that only checks the constant is NAMED
 * passes unchanged if someone empties it.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PLATFORM_MODEL_COMPAT } from "@appstrate/runner-pi/model-compat";

const REPO_ROOT = join(import.meta.dir, "../../../..");

/**
 * Directories the scan never enters. `Bun.Glob` already skips `node_modules` and
 * dot-directories, so this is belt-and-braces for those two — but `test`/`tests`
 * is load-bearing: fixtures build model records freely and none of them are
 * platform-billed, so a test file in the scan set would report builders that the
 * rule does not and should not apply to. Same reason for the `.test.ts` suffix,
 * which catches a test that does not live under a `test/` directory.
 */
const EXCLUDED_SEGMENT_RE = /(^|\/)(node_modules|dist|test|tests)(\/|$)/;

/**
 * Files that construct a `Model<Api>` record — derived, never typed out. Both
 * spellings have to be looked for: `@appstrate/runner-pi` publicly exports
 * `PiModelConfig` as an alias of `Model<Api>` (`packages/runner-pi/src/index.ts`)
 * precisely so callers can declare this shape by that name, and a scan that only
 * knew the literal spelling would not see them.
 */
const SCANNED_FILES = [...new Bun.Glob("**/*.ts").scanSync({ cwd: REPO_ROOT, onlyFiles: true })]
  .filter((rel) => !EXCLUDED_SEGMENT_RE.test(rel) && !rel.endsWith(".test.ts"))
  .filter((rel) => /Model<Api>|PiModelConfig/.test(readFileSync(join(REPO_ROOT, rel), "utf8")))
  .sort();

/**
 * Every non-test source file, WITHOUT the `Model<Api>|PiModelConfig` content
 * filter above.
 *
 * The builder scan wants that filter — it is looking for declarations typed as
 * a model record, and a file that never names the type has none. The zero-cost
 * duplication rule is not about model records at all: it says the four-zero
 * `ModelCost` literal is spelled once in the tree, and it applies wherever
 * someone writes it. Two of the six sites `ZERO_MODEL_COST` replaced —
 * `module-chat/src/pi-chat/structured-session.ts` and `ui-stream-mapper.ts` —
 * pass the cost through without naming either spelling of the model type, so
 * scanning the narrow set would have let a seventh copy back in at exactly the
 * places the constant was introduced to clean up.
 */
const ZERO_COST_DECLARATION = "packages/runner-pi/src/model-compat.ts";

const ALL_SOURCE_FILES = [...new Bun.Glob("**/*.ts").scanSync({ cwd: REPO_ROOT, onlyFiles: true })]
  .filter((rel) => !EXCLUDED_SEGMENT_RE.test(rel) && !rel.endsWith(".test.ts"))
  // The constant's own definition necessarily contains the literal. Excluded by
  // PATH, not by a content filter, so the exemption is exactly one file and
  // cannot silently grow to cover a real copy. Note this file names neither
  // `Model<Api>` nor `PiModelConfig` — which is why the narrow builder scan
  // never had to exempt it, and equally why that scan could not have policed
  // the two module-chat sites that pass a cost through without naming the type.
  .filter((rel) => rel !== ZERO_COST_DECLARATION)
  .sort();

/**
 * A builder is a declaration whose type says it produces a model record. Both
 * shapes appear: a typed local (`const model: Model<Api> = {`) and a function
 * whose return type is the record (`): Model<Api> {`), under either spelling of
 * the type.
 */
const BUILDER_RE =
  /^.*(?:const \w+: (?:Model<Api>|PiModelConfig) = \{|\): (?:Model<Api>|PiModelConfig) \{)\s*$/gm;

/**
 * Builders that deliberately carry no platform compat, with the reason.
 * Keyed by `<file>:<declaration text, trimmed>`.
 */
const EXEMPT: Record<string, string> = {
  "apps/cli/src/commands/run/model.ts::const model: Model<Api> = {|resolveModel":
    "env mode bills nobody but the caller — their key, straight to the vendor, " +
    "no llm_usage row — so the under-billing this guards against cannot occur.",
  "packages/runner-pi/src/pi-runner.ts::): PiModelConfig {|preserveRequestedThinkingLevel":
    "derives from a caller-supplied record by spread, so it carries whatever " +
    "compat the ORIGIN builder set. Spreading the constant here would be wrong, " +
    "not merely redundant: it would stamp platform compat onto the CLI's " +
    "deliberately exempt env-mode model and hide an origin that forgot.",
  "packages/runner-pi/src/pi-runner.ts::function prepareProviderBaseUrl(model: PiModelConfig): PiModelConfig {|prepareAnthropicThinkingBudgets":
    "same as `preserveRequestedThinkingLevel` — a spread-through transformer of " +
    "a record built elsewhere, not a construction site.",
};

/**
 * Strip comments before matching. Without this the gate answers "yes" to a
 * builder that only NAMES the constant in prose — which is exactly how the
 * first negative control against this file passed while the spread was gone.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Extract each builder region: the declaration through its enclosing block. */
function buildersOf(rel: string): { key: string; body: string }[] {
  const src = readFileSync(join(REPO_ROOT, rel), "utf8");
  const out: { key: string; body: string }[] = [];
  for (const m of src.matchAll(BUILDER_RE)) {
    const start = m.index;
    // A top-level declaration closes at a brace in column 0. Slicing to it
    // keeps each builder's region disjoint from the next one in the same file,
    // which matters for `model.ts` — it holds two, and only one is exempt.
    const end = src.indexOf("\n}\n", start);
    const body = src.slice(start, end === -1 ? src.length : end);
    // Name the enclosing function so an exemption names a builder, not a line
    // number that the next edit invalidates.
    const before = src.slice(0, start);
    const fn = [...before.matchAll(/(?:export )?(?:async )?function (\w+)/g)].pop()?.[1] ?? "?";
    out.push({ key: `${rel}::${m[0].trim()}|${fn}`, body });
  }
  return out;
}

describe("platform model compat coverage", () => {
  const builders = SCANNED_FILES.flatMap(buildersOf);

  it("finds every model builder — an empty scan is a failure, not a pass", () => {
    // The seven the tree holds today: five construction sites and the two
    // spread-through transformers exempted above. A DROP means the regex stopped
    // matching a shape that still exists, which would make every assertion below
    // vacuous; a RISE means a new builder nobody has classified yet.
    expect(builders.length).toBe(7);
  });

  it("the constant still refuses long cache retention", () => {
    // Every assertion below only checks that the TOKEN `PLATFORM_MODEL_COMPAT`
    // appears at each site. Emptying the constant satisfies all of them while
    // removing the refusal entirely, so the value has to be pinned here. Turning
    // this flag back on is a pricing change — see the constant's own doc.
    expect(PLATFORM_MODEL_COMPAT).toEqual({ supportsLongCacheRetention: false });
  });

  it("every non-exempt builder spreads PLATFORM_MODEL_COMPAT", () => {
    const missing = builders
      .filter((b) => !(b.key in EXEMPT))
      .filter((b) => !stripComments(b.body).includes("...PLATFORM_MODEL_COMPAT"))
      .map((b) => b.key);
    expect(missing).toEqual([]);
  });

  it("every exemption matches a builder that really exists", () => {
    // The other direction. Without this the list becomes a graveyard: an
    // exemption for a builder that was deleted or renamed would keep excusing
    // nothing, and the next reader would trust it.
    const keys = new Set(builders.map((b) => b.key));
    const stale = Object.keys(EXEMPT).filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
  });

  it("the flag is spelled once, in the constant — never copied back out", () => {
    // The failure mode this whole gate replaces: a fourth hand-written copy,
    // which passes the assertions above while re-forking the rationale.
    const copies = ALL_SOURCE_FILES.filter((f) =>
      stripComments(readFileSync(join(REPO_ROOT, f), "utf8")).includes(
        "supportsLongCacheRetention",
      ),
    );
    expect(copies).toEqual([]);
  });
  it("the zero cost record is spelled once, in the constant — never copied back out", () => {
    // Same failure mode as the assertion above, with one extra edge: this
    // literal carries TWO rationales — load-bearing opacity in the sidecar
    // (a real rate card is one catalog lookup from naming the vendor an alias
    // hides) and required-shape filler everywhere else — so a hand-written
    // copy also erases which one applies. See `ZERO_MODEL_COST`.
    //
    // Whitespace-normalised because the literal was prettier-wrapped at three
    // of the six sites it replaced, and a line-oriented match misses those.
    // Anchored on the closing brace, optionally past the `total` roll-up, so it
    // matches a `ModelCost` and NOT the `Usage` token counts, which open with
    // the same four keys and continue `, totalTokens: 0, cost: …`.
    const ZERO_COST_LITERAL =
      /\binput:\s*0,\s*output:\s*0,\s*cacheRead:\s*0,\s*cacheWrite:\s*0\s*(?:,\s*total:\s*0\s*)?,?\s*\}/;
    const copies = ALL_SOURCE_FILES.filter((f) =>
      ZERO_COST_LITERAL.test(
        stripComments(readFileSync(join(REPO_ROOT, f), "utf8")).replace(/\s+/g, " "),
      ),
    );
    expect(copies).toEqual([]);
  });
});
