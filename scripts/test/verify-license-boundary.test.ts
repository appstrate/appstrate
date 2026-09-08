// SPDX-License-Identifier: Apache-2.0

/**
 * The classifier behind `verify:license-boundary`.
 *
 * The repo scan reports only what the tree happens to contain; these assertions
 * drive each branch from synthetic input, so the commercial side — the whole
 * reason the gate exists — stays exercised whatever the tree looks like.
 */

import { describe, it, expect } from "bun:test";
import {
  LICENSED_GLOBS,
  checkLicenseHeader,
  expectedLicenseFor,
} from "../verify-license-boundary.ts";
import { SOURCE_GLOBS } from "../lib/tracked-files.ts";

const APACHE = "// SPDX-License-Identifier: Apache-2.0";
const COMMERCIAL = "// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial";

describe("expectedLicenseFor", () => {
  it("puts packages/module-ee under the commercial licence", () => {
    expect(expectedLicenseFor("packages/module-ee/src/index.ts")).toBe(
      "LicenseRef-Appstrate-Commercial",
    );
  });

  it("puts everything else under Apache-2.0", () => {
    expect(expectedLicenseFor("packages/module-chat/src/index.ts")).toBe("Apache-2.0");
    // Prefix matching, not substring: a sibling package whose name merely
    // starts the same way is Apache-2.0.
    expect(expectedLicenseFor("packages/module-eee/src/index.ts")).toBe("Apache-2.0");
  });
});

describe("checkLicenseHeader", () => {
  it("accepts each side carrying its own header", () => {
    expect(checkLicenseHeader("apps/api/src/index.ts", [APACHE])).toBeNull();
    expect(checkLicenseHeader("packages/module-ee/src/index.ts", [COMMERCIAL])).toBeNull();
  });

  it("accepts a header preceded by a shebang or a triple-slash directive", () => {
    expect(
      checkLicenseHeader("scripts/x.ts", [
        "#!/usr/bin/env bun",
        '/// <reference types="bun" />',
        APACHE,
      ]),
    ).toBeNull();
  });

  it("reports a missing header", () => {
    expect(checkLicenseHeader("apps/api/src/index.ts", ["export const a = 1;"])).toContain(
      "no SPDX header in the first 3 lines",
    );
  });

  it("reports a header pushed past the third line", () => {
    expect(checkLicenseHeader("apps/api/src/index.ts", ["", "", "", APACHE])).toContain(
      "no SPDX header",
    );
  });

  it("reports Apache-2.0 inside the commercial directory", () => {
    // The defect the gate is for: a file moved into `packages/module-ee/` keeps
    // the licence of where it came from, and nothing else in the toolchain
    // notices.
    const problem = checkLicenseHeader("packages/module-ee/src/billing.ts", [APACHE]);
    expect(problem).toContain(
      "expected `// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial`",
    );
  });

  it("reports the commercial licence outside that directory", () => {
    const problem = checkLicenseHeader("packages/core/src/x.ts", [COMMERCIAL]);
    expect(problem).toContain("expected `// SPDX-License-Identifier: Apache-2.0`");
  });

  it("rejects a non-`//` comment form", () => {
    // No tracked source file uses one, so accepting `#` or `<!-- -->` would be
    // a branch nothing writes and nothing reads.
    expect(
      checkLicenseHeader("apps/api/src/index.ts", ["# SPDX-License-Identifier: Apache-2.0"]),
    ).toContain("expected");
    expect(
      checkLicenseHeader("apps/api/src/index.ts", ["<!-- SPDX-License-Identifier: Apache-2.0 -->"]),
    ).toContain("expected");
  });
});

describe("LICENSED_GLOBS", () => {
  it("covers every extension eslint lints, plus `.mts` and `.cts`", () => {
    // A licence claim on `.ts` alone leaves an unmarked `.mjs` — the shape the
    // repo actually had: `eslint.config.mjs` carried no header while the gate
    // reported clean.
    expect(LICENSED_GLOBS).toEqual([...SOURCE_GLOBS, "*.mts", "*.cts"]);
  });
});
