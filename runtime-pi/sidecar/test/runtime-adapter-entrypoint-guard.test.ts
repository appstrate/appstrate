// SPDX-License-Identifier: Apache-2.0

/**
 * E4 — entryPoint path-traversal guard (sandbox-escape defense).
 *
 * `resolveBundleEntry` is the shared containment guard used by both the
 * docker adapter (`planContainer`, before `docker cp`) and the process
 * adapter (`planSubprocess`, before spawning a host subprocess). A
 * malformed/malicious manifest `entryPoint` must never resolve to a path
 * outside the extracted bundle root — otherwise an attacker-authored
 * integration could exfiltrate or execute host files.
 *
 * Runs fully in-process — no Docker, no PostgreSQL.
 */

import { describe, it, expect } from "bun:test";
import { resolveBundleEntry } from "../integration-runtime-adapter.ts";

// Use a POSIX absolute root — the sidecar always extracts bundles to a Linux
// path (`/tmp/afps-integ-<ns>-XXX/`), and the guard compares against the
// POSIX separator.
const BUNDLE_ROOT = "/tmp/afps-integ-gmail-abc123";

describe("resolveBundleEntry — containment guard", () => {
  const escapes: Array<[string, string]> = [
    ["parent traversal", "../../etc/passwd"],
    ["mid-path escape", "a/../../b"],
    ["deep escape back to root", "server/../../../../../../etc/shadow"],
    ["single parent dir", ".."],
    ["dot-slash parent", "./../escape"],
  ];

  for (const [label, entry] of escapes) {
    it(`throws on ${label}: ${entry}`, () => {
      expect(() => resolveBundleEntry(BUNDLE_ROOT, entry)).toThrow(/escapes bundle root/);
    });
  }

  // NOTE on absolute entryPoints: `node:path.join(root, "/etc/passwd")`
  // treats the leading slash as a path *segment*, producing
  // `<root>/etc/passwd` — i.e. an absolute entryPoint is RE-ROOTED under
  // the bundle, not allowed to escape. This is the production behavior
  // (the guard has always used `normalize(join(root, entry))`), so an
  // absolute path is contained rather than rejected.
  const containedAbsolutes: Array<[string, string, string]> = [
    ["absolute /etc/passwd", "/etc/passwd", "/tmp/afps-integ-gmail-abc123/etc/passwd"],
    [
      "absolute sibling-looking path",
      "/tmp/other-bundle/index.js",
      "/tmp/afps-integ-gmail-abc123/tmp/other-bundle/index.js",
    ],
  ];

  for (const [label, entry, expected] of containedAbsolutes) {
    it(`re-roots ${label} under the bundle root (no escape): ${entry}`, () => {
      expect(resolveBundleEntry(BUNDLE_ROOT, entry)).toBe(expected);
    });
  }

  const legit: Array<[string, string, string]> = [
    ["nested entry", "server/index.js", "/tmp/afps-integ-gmail-abc123/server/index.js"],
    ["top-level entry", "main.py", "/tmp/afps-integ-gmail-abc123/main.py"],
    ["dot-slash prefix", "./server/index.js", "/tmp/afps-integ-gmail-abc123/server/index.js"],
    [
      "normalized internal dots",
      "server/./nested/../index.js",
      "/tmp/afps-integ-gmail-abc123/server/index.js",
    ],
  ];

  for (const [label, entry, expected] of legit) {
    it(`resolves ${label} inside the bundle root: ${entry}`, () => {
      expect(resolveBundleEntry(BUNDLE_ROOT, entry)).toBe(expected);
    });
  }

  it("rejects a sibling directory sharing the root as a prefix (no prefix-match bypass)", () => {
    // `/tmp/afps-integ-gmail-abc123-evil` starts with the root string but is
    // NOT inside it. The guard appends `posix.sep` before the startsWith
    // check, so this must still be rejected.
    expect(() => resolveBundleEntry(BUNDLE_ROOT, "../afps-integ-gmail-abc123-evil/x")).toThrow(
      /escapes bundle root/,
    );
  });
});
