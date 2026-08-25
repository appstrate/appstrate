// SPDX-License-Identifier: Apache-2.0

/**
 * The one property every gate built on `git ls-files` depends on and none of
 * them could state on its own: **an empty match is a failure, not a pass**.
 *
 * Three gates — `scripts/lint.ts`, `scripts/lint-manifest-casing.ts`,
 * `scripts/verify-compose-defaults.ts` — each carried their own copy of the
 * spawn, the exit-code check, the NUL split and the vacuity throw. Every one of
 * them turns its file list into a `for` loop whose body is the whole gate, so a
 * copy that lost the throw would report a clean run over zero files, in the
 * cheerful past tense, for as long as nobody looked. One implementation, and
 * the assertions below hold it.
 *
 * The second property, added after the unification lost it: the deleted-file
 * allowance is a per-caller CHOICE. Unifying three different answers on one
 * silent pre-filter handed `verify-compose-defaults` an allowance it never
 * wanted, and `rm docker-compose.yml` became a green tick. `MissingFilePolicy`
 * is asserted below in both directions.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPOSE_GLOBS,
  missingFromWorktree,
  SOURCE_GLOBS,
  trackedFiles,
  trackedIndexFiles,
} from "../lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("trackedFiles", () => {
  it("throws instead of returning an empty list", () => {
    // The failure mode this module exists for. A gate handed `[]` iterates
    // nothing, finds nothing, and prints its success line.
    expect(() => trackedFiles(["*.zz-no-such-extension"], "widget", "skip")).toThrow(
      /matched no widget — the gate would pass vacuously/,
    );
  });

  it("names the population in the vacuity error", () => {
    // Three gates share this throw, so the message has to say which one is
    // suddenly looking at nothing.
    expect(() => trackedFiles(["*.zz-no-such-extension"], "compose file", "fail")).toThrow(
      /matched no compose file/,
    );
  });

  it("returns tracked source files, sorted", () => {
    const files = trackedFiles(SOURCE_GLOBS, "source file", "skip");
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toEqual([...files].sort());
    // Anchors rather than a count, so this does not fail on every file added.
    // All three are long-lived tracked paths — a file this branch adds is not
    // in the INDEX until it is committed, and would make this test red until
    // then for a reason that has nothing to do with the property.
    expect(files).toContain("scripts/lint.ts");
    expect(files).toContain("scripts/lib/policy-env.ts");
    expect(files).toContain("eslint.config.mjs");
  });

  it("returns only paths that exist on disk under `skip`", () => {
    // The index can name a file already removed from the working tree (a
    // `git rm` not yet committed). `lint.ts` and `lint-manifest-casing.ts` ask
    // for those to be dropped, which is what lets them read the returned paths
    // plainly and is why the latter no longer needs its own ENOENT catch.
    expect(missingFromWorktree(trackedFiles(SOURCE_GLOBS, "source file", "skip"))).toEqual([]);
  });

  it("finds the compose files the drift gate scans", () => {
    const files = trackedFiles(COMPOSE_GLOBS, "compose file", "fail");
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => /docker-compose.*\.ya?ml$/.test(f))).toBe(true);
    expect(files).toContain("docker-compose.yml");
  });
});

describe("missingFromWorktree", () => {
  it("separates index entries with a file from ones without", () => {
    // The primitive both policies are built on. A path that IS tracked and a
    // path that is not even a file, so the answer cannot be "all" or "none" by
    // accident.
    expect(missingFromWorktree(["scripts/lint.ts", "zz/never/existed.ts"])).toEqual([
      "zz/never/existed.ts",
    ]);
  });
});

describe("trackedIndexFiles", () => {
  it("keeps index entries the working tree does not have", () => {
    // The distinction `lint.ts` needs: `KNOWN_IGNORED` liveness is a question
    // about the INDEX, so deleting a generated-and-ignored file must not read
    // as "this entry stopped excluding anything".
    const indexed = trackedIndexFiles(SOURCE_GLOBS, "lintable file");
    const present = trackedFiles(SOURCE_GLOBS, "source file", "skip");
    expect(indexed.length).toBeGreaterThanOrEqual(present.length);
    expect(indexed).toEqual([...indexed].sort());
    expect(indexed).toContain("scripts/lint.ts");
  });

  it("throws on an empty match like every caller of it", () => {
    expect(() => trackedIndexFiles(["*.zz-no-such-extension"], "widget")).toThrow(
      /matched no widget/,
    );
  });
});

/**
 * `turbo.json`'s `//#lint` inputs restate `SOURCE_GLOBS` — turbo reads JSON and
 * cannot import TypeScript, so this is the one copy the repo keeps on purpose.
 *
 * A copy is only worth keeping if something checks it, and the assertion that
 * used to live here checked nothing: it compared `[...SOURCE_GLOBS]` to a
 * hand-typed literal of `SOURCE_GLOBS` and never opened `turbo.json` at all.
 * Rewriting the turbo glob to `**\/*.{ts,tsx}` — dropping four of the six
 * extensions eslint lints, so every `.js/.jsx/.mjs/.cjs` finding would arrive
 * once and then be cached away forever — left it green.
 */
describe("turbo.json's restatement of SOURCE_GLOBS", () => {
  /** `turbo.json` is JSONC. Every comment in it is a whole-line one. */
  function readTurboTasks(): Record<string, { inputs?: string[] }> {
    const raw = readFileSync(join(REPO_ROOT, "turbo.json"), "utf8");
    const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
      tasks?: Record<string, { inputs?: string[] }>;
    };
    if (!parsed.tasks) throw new Error("turbo.json: no `tasks` — the assertion below cannot work.");
    return parsed.tasks;
  }

  it("matches exactly the extensions the lint scope claims", () => {
    const inputs = readTurboTasks()["//#lint"]?.inputs;
    expect(inputs).toBeDefined();

    // Exactly one input carries a brace group; more than one would mean the
    // extension list had been split and this assertion would be reading half.
    const braceGlobs = (inputs ?? []).filter((glob) => /\{[^}]+\}/.test(glob));
    expect(braceGlobs).toHaveLength(1);

    const group = /\{([^}]+)\}/.exec(braceGlobs[0] ?? "")?.[1] ?? "";
    const extensions = group.split(",").map((ext) => `*.${ext.trim()}`);
    expect(extensions).toEqual([...SOURCE_GLOBS]);
  });

  it("keeps the negations that stop gitignored files entering the hash", () => {
    // Measured in `turbo.json`'s own comment: with a bare `**\/*.{ts,tsx}`,
    // creating `node_modules/.zzprobe/a.ts` moved the task hash, so every
    // `bun install` busted the lint cache. The negations are load-bearing.
    const inputs = readTurboTasks()["//#lint"]?.inputs ?? [];
    expect(inputs).toContain("!**/node_modules/**");
    expect(inputs).toContain("!**/dist/**");
  });
});
