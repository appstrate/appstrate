// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Sanitizer parity — `@appstrate/core/zip:unzipArtifact` (fail-soft filter)
 * vs `@appstrate/afps-runtime/bundle/archive-utils:sanitizeEntries`
 * (fail-closed throw).
 *
 * The two paths deliberately differ on REACTION to a §8.1 violation:
 *
 *   - `core/zip.ts:unzipArtifact` is the user-upload path (the platform's
 *     ZIP-import surface). It SILENTLY DROPS offending entries and keeps
 *     decoding the rest, because user-authored ZIPs commonly carry stray
 *     `__MACOSX/` junk or oddly-cased filenames the publisher shouldn't
 *     have to learn about. This is documented as fail-soft in `zip.ts`.
 *
 *   - `archive-utils.ts:sanitizeEntries` is the trusted-bundle path
 *     (`.afps-bundle` reading). Bundle integrity is RECORD-verified
 *     downstream, so a stray junk entry indicates either tampering or a
 *     buggy publisher — either way, throw and let the operator notice.
 *
 * Both paths MUST reach the SAME verdict on every input — they only disagree
 * on the rejection MODE (filter vs throw).
 *
 * WHY THAT MATTERS, in the two directions it has already failed:
 *
 *   - core LOOSER than runtime: a `PUT` of `sales,2024.csv` was answered
 *     `200` and the bytes published, then every run of every package that
 *     depended on it failed in `sanitizeEntries` with `ARCHIVE_INVALID`.
 *     The author who chose the filename never saw that verdict.
 *   - runtime LOOSER than core: an imported `.afps` carrying `C:/notes.md`
 *     kept that entry in the rebuilt, frozen artifact while the platform's
 *     own file index dropped it — two views of one package disagreeing,
 *     silently.
 *
 * HOW parity is pinned here: NOT by two hand-maintained lists that a future
 * edit can grow on one side only. {@link PARITY_CASES} is ONE table of
 * shapes, each with the one verdict both implementations owe it, and the
 * loop below runs BOTH sanitizers (and the shared predicate
 * `isSafeArchivePath`) over every row. Adding a rule to one sanitizer and
 * not the other fails here by construction — there is no list to forget to
 * update, only a row to add.
 *
 * If you change one sanitizer, change the other, then add the shape here.
 */

import { describe, it, expect } from "bun:test";
import { zipSync } from "fflate";
import { unzipArtifact, isSafeArchivePath } from "@appstrate/core/zip";
import {
  sanitizeEntries,
  type SanitizeOptions,
} from "../../afps-runtime/src/bundle/archive-utils.ts";
import { DEFAULT_BUNDLE_LIMITS } from "../../afps-runtime/src/bundle/limits.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const sanitizeOpts: SanitizeOptions = {
  limits: DEFAULT_BUNDLE_LIMITS,
  context: "parity",
};

/**
 * What both sanitizers owe one shape.
 *
 * - `accept` — the entry survives on both sides.
 * - `drop` — both sides discard it WITHOUT complaint. Reserved for entries
 *   that are meaningless rather than malicious (`__MACOSX/` noise, a bare
 *   directory record): nothing an author can act on, so nothing is raised.
 * - `reject` — both sides refuse it. core rejects by dropping, the runtime
 *   by throwing; that asymmetry is the whole point of the two policies.
 */
type Verdict = "accept" | "drop" | "reject";

const PARITY_CASES: ReadonlyArray<{ path: string; verdict: Verdict; why: string }> = [
  // ── Shapes a package legitimately carries ──────────────────────────────
  { path: "SKILL.md", verdict: "accept", why: "plain root file" },
  { path: "scripts/run.py", verdict: "accept", why: "nested file" },
  { path: "dossier/étude.md", verdict: "accept", why: "non-ASCII is not suspect" },
  { path: "name with spaces.md", verdict: "accept", why: "spaces are not suspect" },
  { path: "file..txt", verdict: "accept", why: "dots inside a segment are not a `..` segment" },
  { path: "..hidden.md", verdict: "accept", why: "leading dots are not a `..` segment" },

  // ── Traversal and absolute paths ───────────────────────────────────────
  { path: "../escape.txt", verdict: "reject", why: "`..` segment — traversal" },
  { path: "dir/../../secret", verdict: "reject", why: "`..` segment mid-path" },
  { path: "/etc/passwd", verdict: "reject", why: "leading `/` — absolute" },
  { path: "dir//file.txt", verdict: "reject", why: "empty segment" },

  // ── Control characters and separator smuggling ─────────────────────────
  { path: "evil\0name.txt", verdict: "reject", why: "null byte" },
  { path: "win\\path.txt", verdict: "reject", why: "backslash — a separator on the target" },

  // ── Signature-RECORD delimiters ────────────────────────────────────────
  // The `.afps` RECORD is one `path,sha256,bytes` line per entry, so either
  // character forges or splits a line. `sanitizeEntries` always refused these;
  // `isSafeArchivePath` did not, which is how a `200` on the write route
  // produced a package no consumer could load.
  { path: "a,b.md", verdict: "reject", why: "comma — RECORD field delimiter" },
  { path: "a\nb.md", verdict: "reject", why: "LF — RECORD line delimiter" },
  { path: "a\rb.md", verdict: "reject", why: "CR — RECORD line delimiter" },
  { path: "docs/q1,q2/report.md", verdict: "reject", why: "comma in a non-final segment" },

  // ── The second spelling of "absolute" ──────────────────────────────────
  // A drive prefix is absolute on the extraction target while every segment
  // reads as relative, so a segment loop structurally cannot see it.
  // `isSafeArchivePath` always refused it; `sanitizeEntries` did not, which is
  // how a rebuilt bundle kept an entry the platform's index had dropped.
  { path: "C:/notes.md", verdict: "reject", why: "Windows drive prefix" },
  { path: "c:/x.md", verdict: "reject", why: "drive prefix, lowercase" },

  // ── `.` segments ───────────────────────────────────────────────────────
  // `./notes.md` and `notes.md` name ONE file; only one survives extraction.
  { path: "./notes.md", verdict: "reject", why: "`.` segment aliases another entry" },
  { path: "a/./b.md", verdict: "reject", why: "`.` segment mid-path" },

  // ── `__proto__` ────────────────────────────────────────────────────────
  // Refused by `assertPath`, so an entry that slipped in via import could
  // never be renamed or deleted afterwards; and unusable as a key in any
  // plain-object accumulator, where assigning it runs the `Object.prototype`
  // setter instead of creating an own property.
  // `__proto__` as the WHOLE name is deliberately absent: `fflate`'s own
  // `zipSync` cannot even build such an archive (its flatten step accumulates
  // into a plain object and throws on the resulting prototype), so there is no
  // input to submit to the two sanitizers. It is covered where it can be —
  // against the predicate directly, in `zip.test.ts`, and against the write
  // route in `apps/api/test/unit/package-files.test.ts`.
  { path: "__proto__/x.md", verdict: "reject", why: "`__proto__` segment at the root" },
  { path: "docs/__proto__/x.md", verdict: "reject", why: "`__proto__` segment nested" },

  // ── Meaningless, not malicious: dropped without complaint ──────────────
  { path: "__MACOSX/._x", verdict: "drop", why: "Finder resource-fork noise" },
  { path: "folder/", verdict: "drop", why: "bare directory record, not a payload" },
];

/**
 * Pack a single subject entry alongside a benign `manifest.json` so both
 * paths have something to operate on. The benign entry is the success-shaped
 * control: both sanitizers MUST preserve it whatever the subject is.
 *
 * The map is null-prototype on purpose: entry NAMES are this test's data, and
 * a plain `{}` gives some of them meaning it must not have — a harness that
 * silently mangles the subject it is meant to submit turns the hardest rows
 * into no-ops that still pass.
 */
function pack(subject: string): {
  raw: Record<string, Uint8Array>;
  zip: Uint8Array;
} {
  const entries = Object.create(null) as Record<string, Uint8Array>;
  entries["manifest.json"] = enc("{}");
  entries[subject] = enc("evil");
  return { raw: entries, zip: zipSync(entries) };
}

interface DualOutcome {
  /** Did the subject survive `unzipArtifact`'s filter? */
  coreKept: boolean;
  /** Did `sanitizeEntries` throw on the batch? */
  runtimeThrew: boolean;
  /** Did the subject survive `sanitizeEntries`? (`false` when it threw.) */
  runtimeKept: boolean;
  /** Was the benign control preserved on both sides? */
  controlSurvived: boolean;
}

function dualOutcome(subject: string): DualOutcome {
  const { raw, zip } = pack(subject);

  // core/zip.ts:unzipArtifact silently filters — read back and see whether the
  // subject survived.
  const coreOut = unzipArtifact(zip);
  const coreKept = Object.prototype.hasOwnProperty.call(coreOut, subject);
  const coreControl = Object.prototype.hasOwnProperty.call(coreOut, "manifest.json");

  // archive-utils.ts:sanitizeEntries operates on the raw fflate output
  // directly (not the zip buffer) — its job is the post-unzip sanitization.
  let runtimeThrew = false;
  let runtimeKept = false;
  let runtimeControl = false;
  try {
    const out = sanitizeEntries(raw, sanitizeOpts);
    runtimeKept = out.has(subject);
    runtimeControl = out.has("manifest.json");
  } catch {
    runtimeThrew = true;
  }

  return {
    coreKept,
    runtimeThrew,
    runtimeKept,
    // When the runtime throws, the whole batch is refused — the control going
    // with it is the fail-closed policy, not a parity failure.
    controlSurvived: coreControl && (runtimeThrew || runtimeControl),
  };
}

describe("sanitizer parity — §8.1 archive-processing rules", () => {
  for (const { path, verdict, why } of PARITY_CASES) {
    it(`${JSON.stringify(path)} → ${verdict} (${why})`, () => {
      const outcome = dualOutcome(path);

      // 1. THE PARITY CLAIM, stated once and asserted the same way for every
      //    row: an entry survives one sanitizer exactly when it survives the
      //    other. This is what a one-sided rule change breaks.
      expect({ path, coreKept: outcome.coreKept }).toEqual({
        path,
        coreKept: outcome.runtimeKept,
      });

      // 2. The shared predicate is the same verdict again — it is what the
      //    write route, the CLI materializer and the web dialog all call, so
      //    a rule that lives only inside `unzipArtifact`'s loop would let
      //    those three disagree with it.
      expect({ path, safe: isSafeArchivePath(path) }).toEqual({
        path,
        safe: outcome.coreKept,
      });

      // 3. The reaction MODE, which is where the two paths are allowed to
      //    differ: only a `reject` may throw, and every `reject` must.
      expect({ path, threw: outcome.runtimeThrew }).toEqual({
        path,
        threw: verdict === "reject",
      });

      // 4. The declared verdict itself.
      expect({ path, kept: outcome.coreKept }).toEqual({ path, kept: verdict === "accept" });

      // 5. Positive control: the rule under test is the only thing acting.
      expect({ path, control: outcome.controlSurvived }).toEqual({ path, control: true });
    });
  }

  it("covers both reaction modes, so the table cannot decay into one column", () => {
    // Guards the guard: a table that lost every `accept` (or every `drop`)
    // would still pass every row above while testing nothing about the
    // fail-soft half of the contract.
    const verdicts = new Set(PARITY_CASES.map((c) => c.verdict));
    expect([...verdicts].sort()).toEqual(["accept", "drop", "reject"]);
  });
});
