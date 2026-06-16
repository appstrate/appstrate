// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `dependency_overrides` value gate (#666) — the syntactic
 * check applied per-dependency on the run trigger + schedule create/update.
 * Resolution-time "does this version exist" checks are separate (422
 * `dependency_unresolved`); this guard only rejects malformed override values.
 */

import { describe, it, expect } from "bun:test";
import { isValidDependencyOverride } from "../../src/services/input-parser.ts";

describe("isValidDependencyOverride", () => {
  it("accepts the literal `draft` selector", () => {
    expect(isValidDependencyOverride("draft")).toBe(true);
  });

  it("accepts exact versions and semver ranges", () => {
    for (const v of ["1.0.0", "^1.0.0", "~2.3", ">=1.2.0 <2.0.0", "*"]) {
      expect(isValidDependencyOverride(v)).toBe(true);
    }
  });

  it("accepts dist-tag names", () => {
    for (const v of ["latest", "next", "beta", "canary-1"]) {
      expect(isValidDependencyOverride(v)).toBe(true);
    }
  });

  it("rejects clearly malformed values", () => {
    for (const v of ["not a version!!", "@@@", "1.0.0 || nonsense!!", "Latest", "v 1"]) {
      expect(isValidDependencyOverride(v)).toBe(false);
    }
  });

  it("treats an empty/whitespace value as the semver `*` wildcard (node-semver semantics)", () => {
    // `semver.validRange("")` → "*", so an empty override is a valid (if
    // surprising) wildcard range, not a malformed value.
    expect(isValidDependencyOverride("")).toBe(true);
  });
});
