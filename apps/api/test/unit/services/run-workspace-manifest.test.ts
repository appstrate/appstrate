// SPDX-License-Identifier: Apache-2.0

/**
 * `parseRunFilesManifest` — the refusal branches of the run-workspace files
 * manifest, which is also the DELETION INDEX.
 *
 * The manifest is read by two consumers with different blast radii: the route
 * that serves it to the container (a bad parse is a 500) and the outbox worker
 * that expands each entry into a storage key it DELETES (a bad parse is a retry
 * then a dead letter). Both derive keys from `workspace_name` through
 * `runWorkspaceFileKey`, so the parser is the only thing standing between a
 * corrupted or tampered manifest object and a read/delete outside the run's own
 * `<runId>/files/` prefix.
 *
 * Two properties are pinned here:
 *
 *  1. every refusal branch fires, with its OWN message — a test that accepted
 *    any error would still pass after a guard was replaced by a different one,
 *    and the three messages are how an operator tells "the object is not JSON"
 *    from "the object is JSON but not a manifest" from "one entry names an
 *    unsafe file";
 *  2. every `workspace_name` the parser ACCEPTS still yields a three-segment
 *    key under `<runId>/files/` — the containment property the guard exists
 *    for, stated over the derived key rather than over the guard's internals.
 *
 * Property 2 is what makes the adversarial table below meaningful. The guard
 * refuses the separators and the relative segments; it does NOT refuse every
 * odd name (percent-encoded traversal, a NUL byte, `...`), and it does not need
 * to — none of those add a path segment, and the storage adapters carry their
 * own `..`/NUL rejection on top (`storage-fs.ts`, `storage-s3.ts`). Asserting
 * the accepted ones by name records that on purpose, so a future widening of
 * `isSafeSegment` is a deliberate change rather than an accident.
 */

import { describe, it, expect } from "bun:test";
import {
  parseRunFilesManifest,
  runWorkspaceFileKey,
} from "../../../src/services/run-workspace-manifest.ts";

const RUN_ID = "run_abc";
const KEY = `${RUN_ID}/manifest.json`;

const bytes = (text: string) => new TextEncoder().encode(text);
const manifestBytes = (value: unknown) => bytes(JSON.stringify(value));
const withName = (workspaceName: unknown) =>
  manifestBytes({ files: [{ name: "report.pdf", workspace_name: workspaceName, size: 12 }] });

/**
 * Assert the EXACT thrown message. `expect().toThrow(string)` matches a
 * substring, which would let "Invalid run workspace manifest" stand in for any
 * of the three — the distinction between them is the point of these tests.
 */
function expectThrowsMessage(fn: () => unknown, message: string) {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(message);
}

const NOT_JSON = `Invalid run workspace manifest (not JSON): ${KEY}`;
const NOT_A_MANIFEST = `Invalid run workspace manifest: ${KEY}`;
const BAD_FILE_NAME = `Invalid file name in run workspace manifest: ${KEY}`;

describe("parseRunFilesManifest — object shape", () => {
  it("refuses bytes that are not JSON", () => {
    expectThrowsMessage(() => parseRunFilesManifest(bytes('{"files": ['), KEY), NOT_JSON);
  });

  it("refuses an empty object — a truncated / zero-length upload", () => {
    expectThrowsMessage(() => parseRunFilesManifest(new Uint8Array(), KEY), NOT_JSON);
  });

  it("refuses a manifest with no `files` key", () => {
    // The pre-#1177 `documents` spelling lands here: an explicit throw rather
    // than an agent booting with an empty workspace, or a teardown that skips
    // every input object and leaves them orphaned in the bucket.
    expectThrowsMessage(
      () => parseRunFilesManifest(manifestBytes({ documents: [] }), KEY),
      NOT_A_MANIFEST,
    );
  });

  it("refuses `files` that is not an array", () => {
    expectThrowsMessage(
      () => parseRunFilesManifest(manifestBytes({ files: {} }), KEY),
      NOT_A_MANIFEST,
    );
    expectThrowsMessage(
      () => parseRunFilesManifest(manifestBytes({ files: "report.pdf" }), KEY),
      NOT_A_MANIFEST,
    );
  });

  it("refuses a root that is valid JSON but not an object", () => {
    for (const root of [null, [], "manifest", 7]) {
      expectThrowsMessage(() => parseRunFilesManifest(manifestBytes(root), KEY), NOT_A_MANIFEST);
    }
  });

  it("refuses an entry that is not an object", () => {
    for (const entry of [null, "report.pdf", 7, []]) {
      expectThrowsMessage(
        () => parseRunFilesManifest(manifestBytes({ files: [entry] }), KEY),
        BAD_FILE_NAME,
      );
    }
  });

  it("refuses a non-string `workspace_name`", () => {
    for (const name of [42, null, true, ["a"], { a: 1 }]) {
      expectThrowsMessage(() => parseRunFilesManifest(withName(name), KEY), BAD_FILE_NAME);
    }
  });

  it("refuses an entry with no `workspace_name` at all", () => {
    expectThrowsMessage(
      () => parseRunFilesManifest(manifestBytes({ files: [{ name: "report.pdf", size: 1 }] }), KEY),
      BAD_FILE_NAME,
    );
  });

  it("refuses the whole manifest when a LATER entry is bad", () => {
    // All-or-nothing: a partial expansion would delete some objects and orphan
    // the rest, with the manifest already gone.
    expectThrowsMessage(
      () =>
        parseRunFilesManifest(
          manifestBytes({
            files: [
              { name: "ok.pdf", workspace_name: "ok.pdf", size: 1 },
              { name: "bad", workspace_name: "../escape", size: 1 },
            ],
          }),
          KEY,
        ),
      BAD_FILE_NAME,
    );
  });
});

describe("parseRunFilesManifest — accepted manifests", () => {
  it("parses a well-formed manifest", () => {
    expect(
      parseRunFilesManifest(
        manifestBytes({ files: [{ name: "Report.pdf", workspace_name: "report.pdf", size: 12 }] }),
        KEY,
      ),
    ).toEqual({ files: [{ name: "Report.pdf", workspace_name: "report.pdf", size: 12 }] });
  });

  it("accepts an empty `files` array — a run provisioned with no input files", () => {
    expect(parseRunFilesManifest(manifestBytes({ files: [] }), KEY)).toEqual({ files: [] });
  });

  it("falls back to `workspace_name` and 0 when `name` / `size` are wrong-typed", () => {
    // Only `workspace_name` derives a key, so the two display-only fields are
    // coerced rather than refused — losing a display name must not strand the
    // objects the deletion index points at.
    expect(
      parseRunFilesManifest(
        manifestBytes({ files: [{ name: 5, workspace_name: "report.pdf", size: "12" }] }),
        KEY,
      ),
    ).toEqual({ files: [{ name: "report.pdf", workspace_name: "report.pdf", size: 0 }] });
  });

  it("ignores unknown keys on an entry", () => {
    expect(
      parseRunFilesManifest(
        manifestBytes({ files: [{ workspace_name: "report.pdf", storage_key: "/etc/passwd" }] }),
        KEY,
      ),
    ).toEqual({ files: [{ name: "report.pdf", workspace_name: "report.pdf", size: 0 }] });
  });
});

/**
 * Adversarial `workspace_name` values, and whether the guard refuses each.
 *
 * `refused: false` is NOT a gap by itself — see the containment assertion
 * below, which is the property that matters. It is recorded so that widening
 * or narrowing `isSafeSegment` shows up here as an intentional edit.
 */
const NAMES: Array<{ label: string; name: string; refused: boolean }> = [
  { label: "relative traversal", name: "../other-run/secret", refused: true },
  { label: "bare `..`", name: "..", refused: true },
  { label: "bare `.`", name: ".", refused: true },
  { label: "empty segment", name: "", refused: true },
  { label: "absolute path", name: "/etc/passwd", refused: true },
  { label: "nested relative path", name: "subdir/report.pdf", refused: true },
  { label: "deep traversal", name: "../../../../etc/passwd", refused: true },
  { label: "trailing separator", name: "subdir/", refused: true },
  { label: "backslash traversal", name: "..\\..\\windows\\system32", refused: true },
  { label: "single backslash", name: "a\\b", refused: true },
  { label: "percent-encoded traversal", name: "%2e%2e%2f%2e%2e%2fsecret", refused: false },
  { label: "half-encoded traversal", name: "..%2Fsecret", refused: false },
  { label: "NUL byte", name: "a\u0000b", refused: false },
  { label: "newline", name: "a\nb", refused: false },
  { label: "three dots", name: "...", refused: false },
  { label: "dot-dot with a suffix", name: "..;", refused: false },
  { label: "dot-dot padded with spaces", name: " .. ", refused: false },
  { label: "leading dot", name: ".hidden", refused: false },
  { label: "fullwidth solidus", name: "..／secret", refused: false },
];

describe("parseRunFilesManifest — `workspace_name` path-traversal guard", () => {
  for (const { label, name, refused } of NAMES) {
    it(`${refused ? "refuses" : "accepts"} ${label}`, () => {
      if (refused) {
        expectThrowsMessage(() => parseRunFilesManifest(withName(name), KEY), BAD_FILE_NAME);
        return;
      }
      expect(parseRunFilesManifest(withName(name), KEY).files[0]!.workspace_name).toBe(name);
      // An accepted name must still land inside the run's own prefix. Asserted
      // over the SEGMENTS of the key the two consumers actually build, not over
      // the string: a name that smuggled in a separator would widen the key
      // however innocuous it looked.
      expect(runWorkspaceFileKey(RUN_ID, name).split("/")).toEqual([RUN_ID, "files", name]);
    });
  }
});
