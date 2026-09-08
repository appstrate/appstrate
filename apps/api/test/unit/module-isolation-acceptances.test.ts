// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure decisions in `scripts/verify-module-isolation.ts` —
 * the two-directional acceptance check (module → module) and the platform
 * import review (core → module).
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
  importSpecifiers,
  reviewCrossModuleImports,
  reviewPlatformModuleImports,
  type AcceptedCrossModuleImport,
  type CrossModuleImport,
  type PlatformImport,
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

describe("reviewPlatformModuleImports", () => {
  it("reports a bare `@appstrate/module-*` import from platform source", () => {
    const bare: PlatformImport = {
      file: "apps/api/src/lib/boot.ts",
      spec: "@appstrate/module-chat",
    };
    const problems = reviewPlatformModuleImports([bare]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("reaches into a module");
  });

  it("reports a relative import that lands inside packages/module-*", () => {
    const problems = reviewPlatformModuleImports([
      {
        file: "packages/core/src/naming.ts",
        spec: "../../module-chat/src/index.ts",
        resolved: "packages/module-chat/src/index.ts",
      },
    ]);
    expect(problems).toHaveLength(1);
  });

  it("reports a relative import that lands inside a built-in module", () => {
    // Built-ins live under `apps/api/src`, so a platform file reaches one with
    // an ordinary relative path — no `@appstrate/module-*` specifier involved.
    const problems = reviewPlatformModuleImports([
      {
        file: "apps/api/src/lib/boot.ts",
        spec: "../modules/oidc/index.ts",
        resolved: "apps/api/src/modules/oidc/index.ts",
      },
    ]);
    expect(problems).toHaveLength(1);
  });

  it("passes ordinary platform imports", () => {
    // The negative control. A rule that reported nothing and a rule that
    // reported everything would both leave the scan "clean" on today's repo.
    expect(
      reviewPlatformModuleImports([
        { file: "apps/api/src/lib/boot.ts", spec: "@appstrate/core/module" },
        { file: "apps/api/src/lib/boot.ts", spec: "hono" },
        {
          file: "apps/api/src/lib/boot.ts",
          spec: "./modules/module-loader.ts",
          resolved: "apps/api/src/lib/modules/module-loader.ts",
        },
      ]),
    ).toEqual([]);
  });

  it("does not mistake a package whose name merely starts with `module-`", () => {
    expect(
      reviewPlatformModuleImports([
        { file: "apps/api/src/x.ts", spec: "@appstrate/modules-registry" },
        {
          file: "apps/api/src/x.ts",
          spec: "../../modules-registry/src/index.ts",
          resolved: "packages/modules-registry/src/index.ts",
        },
      ]),
    ).toEqual([]);
  });
});

describe("importSpecifiers", () => {
  it("reads a literal `import()` written with backticks", () => {
    expect(importSpecifiers("void import(`@appstrate/module-ee`);")).toEqual([
      "@appstrate/module-ee",
    ]);
  });

  it("does not read a template with a substitution — that is the loader's form", () => {
    expect(importSpecifiers("void import(`@appstrate/module-${id}`);")).toEqual([]);
  });

  it("ignores an import inside a comment", () => {
    const source = [
      '// import "@appstrate/module-ee";',
      '/* import "@appstrate/module-chat"; */',
      'import { boot } from "./boot.ts";',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["./boot.ts"]);
  });

  it("does not mistake a `//` inside a specifier for a comment", () => {
    expect(importSpecifiers('import { x } from "https://example.test/x.ts";')).toEqual([
      "https://example.test/x.ts",
    ]);
  });

  it("does not let a JSX closing tag swallow the commented-out import behind it", () => {
    // The scan reads `.tsx` too. With `<` treated as a regex preceder, the `/`
    // in `</div>` opened a phantom regex that ran to the next `/` — the `//` of
    // the comment below — and the commented-out import behind it reached the
    // scan as a live one: a hard violation on a line that imports nothing.
    const source = [
      "export function Panel() {",
      "  return <div>x</div>;",
      "}",
      '// import "@appstrate/module-ee";',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual([]);
  });

  it("still catches a REAL import after JSX", () => {
    // The other half. A fix that made the scan skip everything behind JSX
    // would pass the test above and blind the gate.
    const source = [
      "export function Panel() {",
      "  return <div>x</div>;",
      "}",
      'import "@appstrate/module-ee";',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["@appstrate/module-ee"]);
  });

  it("reads past a regex literal holding quote characters", () => {
    // Treated as a string, the `["']` swallows the rest of the file and the
    // import behind it disappears from the scan.
    const source = ["const RE = /[\"']/g;", 'import "@appstrate/module-ee";'].join("\n");
    expect(importSpecifiers(source)).toEqual(["@appstrate/module-ee"]);
  });
});
