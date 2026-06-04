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
 * Both paths MUST reject the SAME inputs under §8.1 — they only disagree
 * on the rejection MODE (filter vs throw). This test pins parity on the
 * input set so a future regression in one path can't silently let
 * something through that the other already catches.
 *
 * If you change one sanitizer, change the other, then update this test.
 */

import { describe, it, expect } from "bun:test";
import { zipSync } from "fflate";
import { unzipArtifact } from "@appstrate/core/zip";
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
 * Pack a single bad entry alongside a benign manifest.json so both paths
 * have something to operate on. The benign entry is the success-shaped
 * control: both sanitizers MUST preserve it; only the offending key is
 * the test subject.
 */
function pack(badKey: string): {
  raw: Record<string, Uint8Array>;
  zip: Uint8Array;
} {
  const entries: Record<string, Uint8Array> = {
    "manifest.json": enc("{}"),
    [badKey]: enc("evil"),
  };
  return { raw: entries, zip: zipSync(entries) };
}

/**
 * Run both sanitizers on the same logical input and report:
 *   - `core/zip` outcome: whether `badKey` survived the filter
 *   - `archive-utils` outcome: did it throw (fail-closed) or accept (kept)?
 *
 * Both sides MUST agree on "reject" — `core/zip` rejects by DROPPING the
 * entry, `archive-utils` rejects by THROWING. The test below asserts this
 * dual rejection per §8.1 input.
 */
function dualOutcome(badKey: string): {
  coreKept: boolean;
  runtimeThrew: boolean;
} {
  const { raw, zip } = pack(badKey);

  // core/zip.ts:unzipArtifact silently filters — read back and see if the
  // bad key survived.
  const coreOut = unzipArtifact(zip);
  const coreKept = Object.prototype.hasOwnProperty.call(coreOut, badKey);

  // archive-utils.ts:sanitizeEntries operates on the raw fflate output
  // directly (not the zip buffer) — its job is the post-unzip
  // sanitization. Pass the raw map and observe whether it throws.
  let runtimeThrew = false;
  try {
    sanitizeEntries(raw, sanitizeOpts);
  } catch {
    runtimeThrew = true;
  }
  return { coreKept, runtimeThrew };
}

describe("sanitizer parity — §8.1 archive-processing rules", () => {
  it("rejects path traversal entries (.. segments)", () => {
    const { coreKept, runtimeThrew } = dualOutcome("../escape.txt");
    expect(coreKept).toBe(false); // core: filtered out
    expect(runtimeThrew).toBe(true); // runtime: thrown
  });

  it("rejects null-byte entries", () => {
    const { coreKept, runtimeThrew } = dualOutcome("evil\0name.txt");
    expect(coreKept).toBe(false);
    expect(runtimeThrew).toBe(true);
  });

  it("rejects backslash entries", () => {
    const { coreKept, runtimeThrew } = dualOutcome("win\\path.txt");
    expect(coreKept).toBe(false);
    expect(runtimeThrew).toBe(true);
  });

  it("rejects absolute-path entries", () => {
    const { coreKept, runtimeThrew } = dualOutcome("/etc/passwd");
    expect(coreKept).toBe(false);
    expect(runtimeThrew).toBe(true);
  });

  it("drops __MACOSX/ metadata silently on both sides", () => {
    // __MACOSX/* is the one §8.1 input both sides skip silently — the
    // entry is meaningless, not malicious, so neither sanitizer surfaces
    // it as an error. The control is "kept=false on both sides; runtime
    // does NOT throw".
    const { raw, zip } = pack("__MACOSX/._x");

    const coreOut = unzipArtifact(zip);
    const coreKept = Object.prototype.hasOwnProperty.call(coreOut, "__MACOSX/._x");
    expect(coreKept).toBe(false);

    // Runtime: must not throw, must filter out.
    const runtimeOut = sanitizeEntries(raw, sanitizeOpts);
    expect(runtimeOut.has("__MACOSX/._x")).toBe(false);
  });

  it("drops directory-only entries (trailing /) silently on both sides", () => {
    // A bare directory entry (`folder/`) is structural, not a payload.
    // Both sides drop it without complaint.
    const raw: Record<string, Uint8Array> = {
      "manifest.json": enc("{}"),
      "folder/": enc(""),
    };
    const zip = zipSync(raw);

    const coreOut = unzipArtifact(zip);
    expect(Object.prototype.hasOwnProperty.call(coreOut, "folder/")).toBe(false);

    const runtimeOut = sanitizeEntries(raw, sanitizeOpts);
    expect(runtimeOut.has("folder/")).toBe(false);
  });
});
