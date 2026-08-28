// SPDX-License-Identifier: Apache-2.0

/**
 * The ENV.md completeness gate, held to both halves of every discrimination.
 *
 * A subset check has exactly one interesting way to be wrong: one of the three
 * populations comes back empty and `A ⊆ B` becomes trivially true. So the
 * parser cases below always assert what IS found alongside what is NOT, and the
 * rule cases always pair a rejected input with an accepted neighbour. "No
 * findings" was the answer the absent gate gave while nine variables were
 * undocumented.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findMissingRequired,
  findUndocumented,
  main,
  readDocumentedVars,
  readEnvExampleVars,
  requiredSchemaKeys,
} from "../verify-env-docs.ts";
import { envSchema } from "../../packages/env/src/index.ts";

/** Resolved from this file's own location, so the cwd a runner picks is irrelevant. */
const ENV_DOC_PATH = join(import.meta.dir, "..", "..", "docs", "ENV.md");
const realDoc = (): string => readFileSync(ENV_DOC_PATH, "utf-8");

/** The two-table shape of the real `docs/ENV.md`, reduced to what the parser reads. */
const DOC = [
  "# Environment Variables",
  "",
  "| Variable   | Required | Default | Notes |",
  "| ---------- | -------- | ------- | ----- |",
  "| `LIVE_ONE` | No       | `1`     | a     |",
  "| `LIVE_TWO` | Yes      | —       | b     |",
  "",
  "## File limits — renamed from `DOCUMENT_*` (breaking)",
  "",
  "| Was                       | Now              | Governs |",
  "| ------------------------- | ---------------- | ------- |",
  "| `DOCUMENT_MAX_FILE_BYTES` | `FILE_MAX_BYTES` | cap     |",
].join("\n");

describe("readDocumentedVars", () => {
  it("reads the main table's variables", () => {
    expect([...readDocumentedVars(DOC)].sort()).toEqual(["LIVE_ONE", "LIVE_TWO"]);
  });

  it("does NOT count the retired-rename table as documentation", () => {
    // The second table lists names boot now REFUSES. Counting them would let a
    // retired spelling satisfy a live key's requirement — the gate would report
    // a documented var that an operator can never set.
    expect(readDocumentedVars(DOC).has("DOCUMENT_MAX_FILE_BYTES")).toBe(false);
    expect(readDocumentedVars(DOC).has("FILE_MAX_BYTES")).toBe(false);
  });

  it("does NOT count a table it has never seen — any header closes the main one", () => {
    // The measured defect: the code tested for `| Was` specifically while its
    // comment claimed any other header ended the table, so a third table —
    // "Deprecated / Replacement", say — had every backticked name in it counted
    // as documented. A live schema key could then lose its row and the gate
    // would stay green on the strength of a retired spelling.
    //
    // Mutation caught: narrowing the header test back to `| Was` returns
    // ["LIVE_ONE", "LIVE_TWO", "SHOULD_NOT_COUNT"].
    //
    // The third table follows the MAIN table directly — that is the repro. Put
    // it after the retired-rename table instead and the `| Was` close already
    // covers it, which is exactly how a test can assert this and still pass
    // against the broken parser.
    const withThirdTable = [
      "# Environment Variables",
      "",
      "| Variable   | Required | Default | Notes |",
      "| ---------- | -------- | ------- | ----- |",
      "| `LIVE_ONE` | No       | `1`     | a     |",
      "| `LIVE_TWO` | Yes      | —       | b     |",
      "",
      "## Deprecated / Replacement",
      "",
      "| Name               | Meaning |",
      "| ------------------ | ------- |",
      "| `SHOULD_NOT_COUNT` | gone    |",
    ].join("\n");
    expect([...readDocumentedVars(withThirdTable)].sort()).toEqual(["LIVE_ONE", "LIVE_TWO"]);
  });

  it("REOPENS the main table when a later `| Variable |` header says so", () => {
    // The other half: closing on any header must not make the parser one-shot.
    // `docs/ENV.md` is free to split the main table in two, and a parser that
    // stopped at the first close would silently document half the file — the
    // same vacuity, one table down.
    const split = [
      DOC,
      "",
      "## More variables",
      "",
      "| Variable    | Required | Default | Notes |",
      "| ----------- | -------- | ------- | ----- |",
      "| `LIVE_MORE` | No       | `1`     | c     |",
    ].join("\n");
    expect([...readDocumentedVars(split)].sort()).toEqual(["LIVE_MORE", "LIVE_ONE", "LIVE_TWO"]);
  });

  it("parses the REAL docs/ENV.md to a non-empty set containing known anchors", () => {
    // The vacuity guard, asserted against the live file rather than a fixture:
    // a reformat that empties the parser is the one failure that turns the
    // whole gate green, and no synthetic input can catch it.
    const real = readDocumentedVars(realDoc());
    expect(real.size).toBeGreaterThan(100);
    expect(real.has("MODULES")).toBe(true);
    expect(real.has("RUN_ADAPTER")).toBe(true);
  });
});

describe("readEnvExampleVars", () => {
  it("reads COMMENTED assignments — nearly every optional var ships commented", () => {
    // Reading only live assignments would see about a dozen of the root file's
    // 122 names, and the subset check would pass over the other 110.
    const names = readEnvExampleVars(
      ["LIVE=1", "# COMMENTED=2", "#   SPACED=3", "# a prose line, not an assignment"].join("\n"),
    );
    expect([...names].sort()).toEqual(["COMMENTED", "LIVE", "SPACED"]);
  });

  it("ignores prose and lowercase noise", () => {
    expect(readEnvExampleVars("# see docs/ENV.md\nfoo=bar\n").size).toBe(0);
  });
});

describe("findUndocumented", () => {
  const documented = new Set(["DOCUMENTED_VAR"]);

  it("reports a schema key with no row", () => {
    const findings = findUndocumented(
      new Set(["DOCUMENTED_VAR", "ZZ_UNDOCUMENTED_SCHEMA_VAR"]),
      new Map(),
      documented,
    );
    expect(findings.map((f) => f.name)).toEqual(["ZZ_UNDOCUMENTED_SCHEMA_VAR"]);
    expect(findings[0]!.source).toContain("Zod schema");
  });

  it("accepts a schema key that HAS a row — the other half", () => {
    expect(findUndocumented(new Set(["DOCUMENTED_VAR"]), new Map(), documented)).toEqual([]);
  });

  it("reports a .env.example key with no row", () => {
    const findings = findUndocumented(
      new Set(),
      new Map([["ZZ_UNDOCUMENTED_EXAMPLE_VAR", ".env.example"]]),
      documented,
    );
    expect(findings.map((f) => f.name)).toEqual(["ZZ_UNDOCUMENTED_EXAMPLE_VAR"]);
    expect(findings[0]!.source).toContain(".env.example");
  });

  it("exempts an allowlisted infra var, and ONLY those", () => {
    // `POSTGRES_USER` is read by the postgres container's entrypoint, never by
    // the platform. `MINIO_ROOT_USER` likewise. A name that is neither is not
    // exempt — asserting only the exemption would pass against an allowlist
    // that swallowed everything.
    const findings = findUndocumented(
      new Set(),
      new Map([
        ["POSTGRES_USER", ".env.example"],
        ["MINIO_ROOT_USER", ".env.example"],
        ["ZZ_NOT_ALLOWLISTED", ".env.example"],
      ]),
      documented,
    );
    expect(findings.map((f) => f.name)).toEqual(["ZZ_NOT_ALLOWLISTED"]);
  });

  it("does not report a .env.example key that the schema also declares", () => {
    // It is reported once, as a schema key, or not at all — never twice.
    const findings = findUndocumented(
      new Set(["DOCUMENTED_VAR"]),
      new Map([["DOCUMENTED_VAR", ".env.example"]]),
      documented,
    );
    expect(findings).toEqual([]);
  });

  it("does NOT report a documented row that no population demands", () => {
    // `OTEL_*`, `RUNNER_IMAGE_*` and the sidecar knobs are read straight from
    // `process.env` and appear in neither the schema nor every example file.
    // The reverse direction is deliberately not checked; if it ever were, it
    // would fire on 21 correct rows.
    expect(findUndocumented(new Set(), new Map(), new Set(["ONLY_DOCUMENTED"]))).toEqual([]);
  });
});

describe("the live repository", () => {
  it("documents every key the schema declares", () => {
    // The end-to-end assertion, stated where a reader looks for it rather than
    // only inside the script's `main()`.
    const documented = readDocumentedVars(realDoc());
    const missing = Object.keys(envSchema.shape).filter((k) => !documented.has(k));
    expect(missing).toEqual([]);
  });
});

/**
 * The direction the two subset checks cannot see.
 *
 * `keys(.env.example) ⊆ rows(ENV.md)` is blind to a key that is simply ABSENT
 * from the example — an absent key is trivially a subset. That blindness let
 * `CONNECT_SESSION_SECRET`, which the schema hard-requires and every
 * self-hosting compose file interpolates as `${…:?…}`, go missing from
 * `examples/self-hosting/.env.example` and hand self-hosters an aborted
 * `docker compose up`.
 */
describe("requiredSchemaKeys", () => {
  it("counts a key that rejects `undefined`, and not one that accepts it", () => {
    // Both halves in one assertion: a rule that returned every key would pass a
    // test that only checked the required one. Stubbed rather than built with
    // `z` because `zod` is a workspace-package dependency, not a root one — the
    // case below anchors the same rule against the REAL schema, which is where
    // Zod's own `.default()` / `.optional()` semantics get exercised.
    const accepts = { safeParse: (): { success: boolean } => ({ success: true }) };
    const rejects = { safeParse: (): { success: boolean } => ({ success: false }) };
    expect([
      ...requiredSchemaKeys({ HARD: rejects, DEFAULTED: accepts, OPTIONAL: accepts }),
    ]).toEqual(["HARD"]);
  });

  it("agrees with the real schema on the five keys boot refuses to start without", () => {
    // Anchored against the live schema, so a key that silently gains a default
    // (and therefore leaves this gate's scope) shows up here rather than as a
    // quiet drop in coverage.
    expect([...requiredSchemaKeys(envSchema.shape)].sort()).toEqual([
      "BETTER_AUTH_SECRET",
      "CONNECTION_ENCRYPTION_KEY",
      "CONNECT_SESSION_SECRET",
      "RUN_TOKEN_SECRET",
      "UPLOAD_SIGNING_SECRET",
    ]);
  });
});

describe("findMissingRequired", () => {
  it("reports a required key missing from ONE file while present in another", () => {
    // The measured shape exactly: present in the root example, absent from the
    // self-hosting one. Mutation caught: merging the per-file sets into one
    // population reports this as covered.
    const missing = findMissingRequired(
      new Set(["CONNECT_SESSION_SECRET"]),
      new Map([
        [".env.example", new Set(["CONNECT_SESSION_SECRET"])],
        ["examples/self-hosting/.env.example", new Set(["BETTER_AUTH_SECRET"])],
      ]),
    );
    expect(missing).toEqual([
      { name: "CONNECT_SESSION_SECRET", file: "examples/self-hosting/.env.example" },
    ]);
  });

  it("reports nothing when every file has every required key — the other half", () => {
    expect(
      findMissingRequired(
        new Set(["A", "B"]),
        new Map([
          [".env.example", new Set(["A", "B", "C"])],
          ["examples/self-hosting/.env.example", new Set(["A", "B"])],
        ]),
      ),
    ).toEqual([]);
  });

  it("does not demand a NON-required key", () => {
    // A defaulted key exists precisely so an operator need not write it down.
    // Forcing all 94 of them into every example would be noise, and a rule that
    // did it would be turned off rather than fixed.
    expect(findMissingRequired(new Set(), new Map([[".env.example", new Set()]]))).toEqual([]);
  });
});

/**
 * `main()`'s decisions, every branch of them.
 *
 * Both vacuity floors, the missing-required report and the undocumented report
 * all END THE GATE, and none was reachable while `main` was unexported and
 * welded to `readFileSync` + `trackedFiles`: deleting either floor left the
 * suite green over an empty population. Each case names the mutation it
 * catches.
 */
describe("main", () => {
  const EXAMPLE = ".env.example";
  const run = (
    files: Record<string, string>,
    over: { schemaKeys?: Set<string>; required?: Set<string> } = {},
  ): { code: number; out: string; err: string } => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main({
      exampleFiles: Object.keys(files).filter((f) => f !== "docs/ENV.md"),
      readFile: (f) => files[f]!,
      schemaKeys: over.schemaKeys ?? new Set(["LIVE_ONE"]),
      required: over.required ?? new Set(["LIVE_ONE"]),
      out: (m) => out.push(m),
      err: (m) => err.push(m),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("passes when the doc covers the schema and the example carries the required key", () => {
    const r = run({ "docs/ENV.md": DOC, [EXAMPLE]: "LIVE_ONE=x\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("hard-required vars appear in every example file");
  });

  it("FAILS the ENV.md vacuity floor — a doc that parses to zero rows", () => {
    // Mutation caught: deleting the `documented.size === 0` branch. With no
    // rows, `keys(schema) ⊆ rows` is false for everything, so the gate would
    // report N doc findings instead of the ONE fact that matters — the parser
    // stopped working. Worse, with an empty schema too it passes outright.
    const r = run({
      "docs/ENV.md": "# Environment Variables\n\nno tables here\n",
      [EXAMPLE]: "LIVE_ONE=x\n",
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("parsed ZERO rows");
  });

  it("FAILS the .env.example vacuity floor — files read, zero variables", () => {
    // Mutation caught: deleting the `envExampleKeys.size === 0` branch. An
    // example file that stopped parsing makes `keys(example) ⊆ rows` trivially
    // true, and the gate prints a tick over a population it never read.
    const r = run({ "docs/ENV.md": DOC, [EXAMPLE]: "# just a comment, no assignments\n" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("parsed ZERO variables");
  });

  it("FAILS when a hard-required key is absent, naming the key AND the file", () => {
    const r = run({
      "docs/ENV.md": DOC,
      [EXAMPLE]: "LIVE_ONE=x\n",
      "examples/self-hosting/.env.example": "LIVE_TWO=y\n",
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("LIVE_ONE");
    expect(r.err).toContain("examples/self-hosting/.env.example");
    expect(r.err).toContain("hard-required");
  });

  it("FAILS when a schema key has no row", () => {
    const r = run(
      { "docs/ENV.md": DOC, [EXAMPLE]: "LIVE_ONE=x\n" },
      { schemaKeys: new Set(["LIVE_ONE", "ZZ_NO_ROW"]) },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("ZZ_NO_ROW");
    expect(r.err).toContain("have no row");
  });

  it("reports the broken install BEFORE the doc gap when both are present", () => {
    // Ordering, asserted: an example missing a required key is an aborted
    // `docker compose up`, not a documentation nit, and burying it under N doc
    // findings is how it goes unread.
    const r = run(
      { "docs/ENV.md": DOC, [EXAMPLE]: "LIVE_TWO=y\n" },
      { schemaKeys: new Set(["LIVE_ONE", "ZZ_NO_ROW"]), required: new Set(["LIVE_ONE"]) },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("hard-required");
    expect(r.err).not.toContain("ZZ_NO_ROW");
  });
});
