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
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../../..");

/** Files that construct a `Model<Api>` record, and what builds it. */
const SCANNED_FILES = [
  "apps/cli/src/commands/run/model.ts",
  "packages/module-chat/src/pi-chat/model-binding.ts",
  "runtime-pi/env.ts",
  "runtime-pi/sidecar/pi-messages-backend.ts",
] as const;

/**
 * A builder is a declaration whose type says it produces a model record. Both
 * shapes appear: a typed local (`const model: Model<Api> = {`) and a function
 * whose return type is the record (`): Model<Api> {`).
 */
const BUILDER_RE = /^.*(?:const \w+: Model<Api> = \{|\): Model<Api> \{)\s*$/gm;

/**
 * Builders that deliberately carry no platform compat, with the reason.
 * Keyed by `<file>:<declaration text, trimmed>`.
 */
const EXEMPT: Record<string, string> = {
  "apps/cli/src/commands/run/model.ts::const model: Model<Api> = {|resolveModel":
    "env mode bills nobody but the caller — their key, straight to the vendor, " +
    "no llm_usage row — so the under-billing this guards against cannot occur.",
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
    // The five the tree holds today. A drop means the regex stopped matching a
    // shape that still exists, which would make every assertion below vacuous.
    expect(builders.length).toBe(5);
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
    const copies = SCANNED_FILES.filter((f) =>
      stripComments(readFileSync(join(REPO_ROOT, f), "utf8")).includes(
        "supportsLongCacheRetention",
      ),
    );
    expect(copies).toEqual([]);
  });
});
