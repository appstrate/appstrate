// SPDX-License-Identifier: Apache-2.0

/**
 * The known-vulnerability gate's two halves, held at once.
 *
 * Every case here runs against FIXTURE payloads, never against the live
 * `bun audit`: that command needs the npm advisory endpoint, and its verdict
 * moves whenever the feed publishes — a suite pinned to it would be red on a
 * morning nobody touched this repo, and green on a morning the network was
 * down and the parser threw somewhere the assertion did not look.
 *
 * The fixture below is a verbatim excerpt of the real payload measured on
 * 2026-09-07 (`bun audit --json`, bun 1.3.11), trimmed to four advisories and
 * with the field names left exactly as the wire carries them —
 * `vulnerable_versions` snake_case included. Re-typing the shape by hand is how
 * a parser test ends up asserting against the schema its author imagined; this
 * one asserts against the schema the tool emits.
 *
 * The negative controls are the point. "No problems" is what a gate that
 * inspected nothing also prints, so each case that expects silence is paired
 * with one that expects a finding out of the SAME payload.
 */

import { describe, it, expect } from "bun:test";
import {
  parseAuditReport,
  reviewAdvisories,
  summaryLine,
  type AcceptedAdvisory,
  type Advisory,
} from "../audit-dependencies.ts";

/**
 * Verbatim excerpt of `bun audit --json` — one critical, one high, one
 * moderate, one low, across three packages.
 */
const FIXTURE = JSON.stringify({
  protobufjs: [
    {
      id: 1117571,
      url: "https://github.com/advisories/GHSA-xq3m-2v4x-88gg",
      title: "Arbitrary code execution in protobufjs",
      severity: "critical",
      vulnerable_versions: "<7.5.5",
      cwe: ["CWE-94"],
      cvss: { score: 9.8, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
    },
    {
      id: 1118924,
      url: "https://github.com/advisories/GHSA-2pr8-phx7-x9h3",
      title: "protobuf.js: Denial of service from crafted field names in generated code",
      severity: "moderate",
      vulnerable_versions: "<=7.5.5",
      cwe: ["CWE-20"],
      cvss: { score: 5.3, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L" },
    },
  ],
  defu: [
    {
      id: 1116102,
      url: "https://github.com/advisories/GHSA-737v-mqg7-c878",
      title: "defu: Prototype pollution via `__proto__` key in defaults argument",
      severity: "high",
      vulnerable_versions: "<=6.1.4",
      cwe: ["CWE-1321"],
      cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N" },
    },
  ],
  "@babel/core": [
    {
      id: 1123528,
      url: "https://github.com/advisories/GHSA-4x5r-pxfx-6jf8",
      title: "@babel/core: Arbitrary File Read via sourceMappingURL Comment",
      severity: "low",
      vulnerable_versions: "<=7.29.0",
      cwe: ["CWE-22", "CWE-200"],
      cvss: { score: 3.2, vectorString: "CVSS:3.1/AV:L/AC:H/PR:N/UI:N/S:C/C:L/I:N/A:N" },
    },
  ],
});

const ADVISORIES = parseAuditReport(FIXTURE);
const TODAY = "2026-09-07";

/** The fixture's high advisory, the one every allowlist case is written about. */
const HIGH: Advisory = ADVISORIES.find((a) => a.id === 1116102)!;

describe("parseAuditReport", () => {
  it("flattens the per-package map, keeping the package name on each advisory", () => {
    expect(ADVISORIES).toHaveLength(4);
    expect(ADVISORIES.map((a) => a.packageName).sort()).toEqual([
      "@babel/core",
      "defu",
      "protobufjs",
      "protobufjs",
    ]);
  });

  it("reads the wire's snake_case `vulnerable_versions` into camelCase", () => {
    // The one field whose name differs between the wire and the TS type. If the
    // mapping breaks it degrades to the "(unknown)" placeholder rather than
    // throwing, so nothing else in the suite would notice.
    expect(HIGH.vulnerableVersions).toBe("<=6.1.4");
    expect(HIGH.severity).toBe("high");
    expect(HIGH.url).toBe("https://github.com/advisories/GHSA-737v-mqg7-c878");
  });

  it("returns nothing for a clean tree", () => {
    expect(parseAuditReport("{}")).toEqual([]);
  });

  it("throws when stdout is not JSON, naming what it saw", () => {
    // The real failure this guards: `bun audit` exits non-zero on ANY advisory,
    // so the exit code cannot tell "found a CVE" from "no lockfile / registry
    // unreachable". Non-JSON stdout is the only signal left, and swallowing it
    // would report a clean tree over a command that never ran.
    expect(() => parseAuditReport("error: Lockfile not found")).toThrow(/did not emit JSON/);
    expect(() => parseAuditReport("")).toThrow(/did not emit JSON/);
  });

  it("throws on a payload shape it does not recognise", () => {
    expect(() => parseAuditReport("[]")).toThrow(/keyed by package name/);
    expect(() => parseAuditReport('{"defu":"nope"}')).toThrow(/not an array of advisories/);
    expect(() => parseAuditReport('{"defu":[{"severity":"high"}]}')).toThrow(/numeric `id`/);
  });

  it("throws on an unknown severity instead of bucketing it", () => {
    // Bucketing an unrecognised severity as non-fatal hides it; bucketing it as
    // fatal red-flags a benign feed addition. Refusing to run puts the decision
    // in front of a human once, which is what `readGatePolicy` does with an
    // unrecognised policy value.
    expect(() => parseAuditReport('{"defu":[{"id":1,"severity":"spicy"}]}')).toThrow(
      /is not one of low, moderate, high, critical/,
    );
  });
});

describe("reviewAdvisories", () => {
  it("fails on a high-severity advisory with no allowlist entry", () => {
    const { problems, counts } = reviewAdvisories(ADVISORIES, [], TODAY);

    // Two fatal findings — the critical and the high — and NOT four. The
    // moderate and the low are in the same payload, so a matcher that fired on
    // everything would pass an assertion written only about the high.
    expect(counts.fatal).toBe(2);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("high advisory 1116102 in `defu`");
    expect(problems.join("\n")).toContain("critical advisory 1117571 in `protobufjs`");
    expect(problems.join("\n")).toContain("add an ACCEPTED_ADVISORIES entry");
  });

  it("does not fail on a moderate or a low advisory", () => {
    // Same payload, allowlist covering both fatal advisories: everything that
    // remains is moderate/low, and the verdict must be silence. Asserting this
    // separately is what pins `FATAL_SEVERITIES` — without it, a change making
    // `moderate` fatal would pass every other case in this file.
    const accepted: AcceptedAdvisory[] = [
      { id: 1116102, packageName: "defu", reason: "unreachable call path", expires: "2026-12-31" },
      {
        id: 1117571,
        packageName: "protobufjs",
        reason: "transitive dev-only dependency",
        expires: "2026-12-31",
      },
    ];
    const { problems, counts } = reviewAdvisories(ADVISORIES, accepted, TODAY);

    expect(problems).toEqual([]);
    expect(counts.fatal).toBe(0);
    expect(counts.allowlisted).toBe(2);
    // The moderate and the low were seen and counted, not filtered out upstream.
    expect(counts.bySeverity).toEqual({ critical: 1, high: 1, moderate: 1, low: 1 });
    expect(counts.inspected).toBe(4);
  });

  it("fails on an allowlist entry that matches nothing (the other direction)", () => {
    const accepted: AcceptedAdvisory[] = [
      {
        id: 999999,
        packageName: "left-pad",
        reason: "patched two releases ago, entry never removed",
        expires: "2026-12-31",
      },
    ];
    const { problems, counts } = reviewAdvisories([HIGH], accepted, TODAY);

    expect(problems.join("\n")).toContain(
      "ACCEPTED_ADVISORIES lists advisory 999999 in `left-pad`",
    );
    expect(problems.join("\n")).toContain("Delete the entry.");

    // The COUNT, not only the message. This pass used to push a problem and
    // increment nothing, so the summary line of a red run read exactly like a
    // clean one's.
    expect(counts.staleAcceptances).toBe(1);
    // `HIGH` is genuinely un-allowlisted here (the entry names another
    // package), so `fatal` is 1 and the two counts are moving independently.
    // The isolated case — stale entry and nothing else — is the next test.
    expect(counts.fatal).toBe(1);
  });

  it("puts the stale count in the summary line of an otherwise clean tree", () => {
    // The regression in full: one rotted entry, nothing else wrong. The gate
    // exits 1 on `problems`, so the line it prints must not be the line a clean
    // run prints.
    const accepted: AcceptedAdvisory[] = [
      { id: 999999, packageName: "left-pad", reason: "long since patched", expires: "2026-12-31" },
    ];
    const { problems, counts } = reviewAdvisories([], accepted, TODAY);

    expect(problems).toHaveLength(1);
    expect(summaryLine(counts)).toBe(
      "0 advisory(ies) across 0 package(s) — 0 critical, 0 high, 0 moderate, 0 low; " +
        "0 allowlisted, 0 fatal, 1 stale allowlist entry(ies).",
    );
    expect(summaryLine(counts)).not.toBe(summaryLine(reviewAdvisories([], [], TODAY).counts));
  });

  it("fails on an entry that only covers a non-fatal advisory", () => {
    // The allowlist is consulted for fatal advisories only, so an entry aimed
    // at a `moderate` suppresses nothing — it is the same dead weight as an
    // entry whose advisory is gone, and reports through the same path.
    const accepted: AcceptedAdvisory[] = [
      {
        id: 1118924,
        packageName: "protobufjs",
        reason: "moderate, accepted — but nothing was ever failing on it",
        expires: "2026-12-31",
      },
    ];
    const { problems } = reviewAdvisories(ADVISORIES, accepted, TODAY);

    expect(problems.join("\n")).toContain(
      "ACCEPTED_ADVISORIES lists advisory 1118924 in `protobufjs`",
    );
  });

  it("fails on an entry past its expiry date", () => {
    const accepted: AcceptedAdvisory[] = [
      { id: 1116102, packageName: "defu", reason: "no upstream fix yet", expires: "2026-09-06" },
    ];
    const { problems, counts } = reviewAdvisories([HIGH], accepted, TODAY);

    // Exactly ONE finding: the expiry. Re-listing the advisory underneath as
    // un-allowlisted would read as two separate things to fix for one decision.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("until 2026-09-06, and today is 2026-09-07");
    expect(counts.fatal).toBe(1);
    expect(counts.allowlisted).toBe(0);
  });

  it("is still green on the expiry date itself", () => {
    // The boundary, asserted because "expired" is an off-by-one waiting to
    // happen and the two neighbouring days are the only evidence of which
    // reading is implemented.
    const accepted: AcceptedAdvisory[] = [
      { id: 1116102, packageName: "defu", reason: "no upstream fix yet", expires: TODAY },
    ];
    expect(reviewAdvisories([HIGH], accepted, TODAY).problems).toEqual([]);
  });

  it("throws on a malformed expiry rather than treating it as never-expiring", () => {
    const bad: AcceptedAdvisory[] = [
      { id: 1116102, packageName: "defu", reason: "typo in the date", expires: "31/12/2026" },
    ];
    expect(() => reviewAdvisories([HIGH], bad, TODAY)).toThrow(/not a YYYY-MM-DD date/);

    // Well-formed but not a real day. String comparison alone would accept it
    // and the entry would expire on a date that does not exist.
    const impossible: AcceptedAdvisory[] = [
      { id: 1116102, packageName: "defu", reason: "typo in the date", expires: "2026-02-31" },
    ];
    expect(() => reviewAdvisories([HIGH], impossible, TODAY)).toThrow(/not a real calendar date/);
  });

  it("matches an entry on package AND id, not on id alone", () => {
    // Advisory ids are unique per affected range, but nothing stops two
    // packages from carrying the same number in a future feed. An entry keyed
    // on the id alone would then exempt a package nobody decided about.
    const accepted: AcceptedAdvisory[] = [
      { id: 1116102, packageName: "not-defu", reason: "wrong package", expires: "2026-12-31" },
    ];
    const { problems, counts } = reviewAdvisories([HIGH], accepted, TODAY);

    expect(counts.allowlisted).toBe(0);
    expect(counts.fatal).toBe(1);
    // Both directions fire: the advisory is unexempted AND the entry is stale.
    expect(problems).toHaveLength(2);
    expect(counts.staleAcceptances).toBe(1);
  });

  it("reports zero of everything for a clean tree", () => {
    const { problems, counts } = reviewAdvisories([], [], TODAY);
    expect(problems).toEqual([]);
    expect(counts).toEqual({
      inspected: 0,
      packages: 0,
      bySeverity: { low: 0, moderate: 0, high: 0, critical: 0 },
      allowlisted: 0,
      fatal: 0,
      staleAcceptances: 0,
    });
  });
});

describe("summaryLine", () => {
  it("carries the counts that tell a clean run from a vacuous one", () => {
    // A gate that prints "OK" without a count is indistinguishable from a gate
    // that inspected nothing — so the numbers are asserted, not just the words.
    const { counts } = reviewAdvisories(ADVISORIES, [], TODAY);
    expect(summaryLine(counts)).toBe(
      "4 advisory(ies) across 3 package(s) — 1 critical, 1 high, 1 moderate, 1 low; " +
        "0 allowlisted, 2 fatal, 0 stale allowlist entry(ies).",
    );
  });
});
