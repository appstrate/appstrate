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
import { findUndocumented, readDocumentedVars, readEnvExampleVars } from "../verify-env-docs.ts";
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
