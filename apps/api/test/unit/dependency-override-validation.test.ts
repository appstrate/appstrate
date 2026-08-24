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

  it("accepts non-protected dist-tag names", () => {
    for (const v of ["next", "beta", "canary-1"]) {
      expect(isValidDependencyOverride(v)).toBe(true);
    }
  });

  it("rejects the protected tag names that carry no per-dependency meaning", () => {
    // `latest` / `published` can never be created as real dist-tags
    // (isProtectedTag), so accepting them here would only defer the failure to
    // a confusing 422 at resolution. `draft` is the one protected name with a
    // dedicated meaning (the working-copy selector) and stays valid.
    expect(isValidDependencyOverride("latest")).toBe(false);
    expect(isValidDependencyOverride("published")).toBe(false);
    expect(isValidDependencyOverride("draft")).toBe(true);
  });

  it("rejects clearly malformed values", () => {
    for (const v of ["not a version!!", "@@@", "1.0.0 || nonsense!!", "Latest", "v 1"]) {
      expect(isValidDependencyOverride(v)).toBe(false);
    }
  });

  it("treats an empty/whitespace value as the semver `*` wildcard (node-semver semantics)", () => {
    // `semver.validRange("")` → "*", so an empty override is a valid (if
    // surprising) wildcard range, not a malformed value.
    //
    // This looks like the empty-string hole that `connection_overrides` had
    // (an empty id there was FALSY at the connection resolver's `resolveOne`,
    // so the pin was skipped in silence — closed with `.min(1)` on all four
    // launch surfaces). It is not the same bug, and the difference is one
    // operator. Traced end to end:
    //
    //   1. `RunPackageCatalog.resolve` applies the override with
    //      `override ?? versionSpec` — NULLISH coalescing, not a truthy check,
    //      so `""` really does replace the manifest pin instead of falling
    //      back to it.
    //   2. `pickVersion` → `resolveVersionString("")` reaches its step-3
    //      range branch, since `semver.validRange("")` is the truthy `"*"`.
    //   3. `semver.maxSatisfying(versions, "")` returns the highest
    //      non-yanked published version — byte-identical to passing `"*"`,
    //      which this file already accepts as valid above.
    //
    // So `""` is MEANINGFUL ("any published version"), never a silent skip,
    // and `.min(1)` here would remove a working selector rather than close a
    // hole. Leave the predicate alone.
    expect(isValidDependencyOverride("")).toBe(true);
    // The name promises whitespace too, and `validRange(" ")` is likewise "*".
    expect(isValidDependencyOverride(" ")).toBe(true);
  });
});
