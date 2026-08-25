// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the two-directional acceptance check in
 * `scripts/verify-module-isolation.ts`.
 *
 * `ACCEPTED_CROSS_MODULE_IMPORTS` is checked both ways: an accepted import must
 * not be reported as a violation, AND an acceptance with no matching import
 * must be reported as stale. Both directions shipped in one commit while the
 * list was — and still is — EMPTY, so nothing in the repo exercised either of
 * them: the matcher recorded `from→to→spec` and the staleness pass looked up
 * `from→to`, keys that can never agree. The first entry anyone added would
 * therefore have been accepted and simultaneously declared dead, failing the
 * gate with the exact opposite of the truth.
 *
 * These tests are the negative control that empty list cannot provide. They
 * feed `reviewCrossModuleImports` a SYNTHETIC acceptance against a SYNTHETIC
 * import — no repo state involved — so the both-directions contract stays
 * exercised however long the real list stays empty.
 */

import { describe, it, expect } from "bun:test";
import {
  reviewCrossModuleImports,
  type AcceptedCrossModuleImport,
  type CrossModuleImport,
} from "../../../../scripts/verify-module-isolation.ts";

const imp: CrossModuleImport = {
  from: "oidc/lib/audiences.ts",
  to: "mcp",
  spec: "../../mcp/lib/resource.ts",
};

const acceptance: AcceptedCrossModuleImport = {
  ...imp,
  reason: "synthetic — exercises the acceptance path the empty real list cannot",
};

describe("reviewCrossModuleImports", () => {
  it("accepts a listed import and does NOT report it stale", () => {
    // The negative control. With the matcher and the staleness pass keyed
    // differently, this single import produced ONE problem: the acceptance
    // matched, then the stale pass failed to find its own record of the match.
    expect(reviewCrossModuleImports([imp], [acceptance])).toEqual([]);
  });

  it("reports a violation when nothing accepts the import", () => {
    const problems = reviewCrossModuleImports([imp], []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("reaches into module `mcp`");
  });

  it("reports an acceptance whose import is gone as stale", () => {
    const problems = reviewCrossModuleImports([], [acceptance]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no such import exists any more");
  });

  it("narrows an acceptance to its one specifier — a sibling import still fails", () => {
    // `spec` is the whole point of the third field: an acceptance keyed on file
    // and owner alone would grant that file blanket permission to import
    // anything else from the same module.
    const sibling: CrossModuleImport = { ...imp, spec: "../../mcp/lib/other.ts" };
    const problems = reviewCrossModuleImports([imp, sibling], [acceptance]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("../../mcp/lib/other.ts");
  });

  it("keeps two acceptances that differ only by specifier independent", () => {
    // Identity matching, not a shared key: the entry the import matched is the
    // entry marked live, so the other one is still reported stale.
    const second: AcceptedCrossModuleImport = {
      ...acceptance,
      spec: "../../mcp/lib/other.ts",
    };
    const problems = reviewCrossModuleImports([imp], [acceptance, second]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("../../mcp/lib/other.ts");
    expect(problems[0]).toContain("no such import exists any more");
  });
});
