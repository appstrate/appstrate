// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for `CORE_VERSION`. The constant is hardcoded (core is consumed
 * over npm, where an ESM JSON import of `package.json` is a portability
 * hazard), so nothing but this test stops it from lying about the published
 * version — and a lying `CORE_VERSION` silently mis-verdicts every module
 * range the loader checks against it (issue #973).
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { CORE_VERSION } from "../src/module.ts";

describe("CORE_VERSION", () => {
  it("matches the published version of @appstrate/core", async () => {
    const pkg = (await Bun.file(join(import.meta.dir, "../package.json")).json()) as {
      version: string;
    };
    expect(CORE_VERSION).toBe(pkg.version);
  });
});
