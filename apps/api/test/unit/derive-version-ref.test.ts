// SPDX-License-Identifier: Apache-2.0

/**
 * `version_ref` derivation (#636) — the unambiguous statement of which agent
 * definition a run executed, derived from the persisted
 * `(version_label, version_dirty)` pair so historical rows need no migration.
 */

import { describe, it, expect } from "bun:test";
import { deriveVersionRef } from "../../src/services/state/runs.ts";

describe("deriveVersionRef", () => {
  it("returns 'draft' when the run executed a dirty draft (label carries the published base)", () => {
    expect(deriveVersionRef("2.1.0", true)).toBe("draft");
  });

  it("returns the semver when the run executed a published definition", () => {
    expect(deriveVersionRef("2.1.0", false)).toBe("2.1.0");
  });

  it("returns 'draft' when the agent had no published version (label NULL)", () => {
    expect(deriveVersionRef(null, false)).toBe("draft");
  });

  it("returns 'draft' for the literal 'draft' label written by the remote-runs registry resolver", () => {
    expect(deriveVersionRef("draft", false)).toBe("draft");
  });

  it("never reports a semver for a dirty run, even with a NULL label", () => {
    expect(deriveVersionRef(null, true)).toBe("draft");
  });
});
