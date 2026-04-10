// SPDX-License-Identifier: Apache-2.0

/**
 * Built-in module auto-discovery.
 *
 * Proves that `discoverBuiltinModules()` finds every subdirectory with an
 * `index.ts` under `apps/api/src/modules/` — no hardcoded list, no mapping
 * to maintain, idempotent across calls.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverBuiltinModules,
  resetBuiltinDiscovery,
} from "../../../src/lib/modules/module-loader.ts";

describe("discoverBuiltinModules", () => {
  beforeEach(() => {
    resetBuiltinDiscovery();
  });

  it("finds the shipped built-in modules in the real modules directory", () => {
    const discovered = discoverBuiltinModules();
    expect(discovered).toContain("webhooks");
    expect(discovered).toContain("provider-management");
    expect(discovered).not.toContain("scheduling"); // moved back into core
  });

  it("returns the full list when called again (idempotent cache)", () => {
    const first = discoverBuiltinModules();
    const second = discoverBuiltinModules();
    expect(second).toEqual(first);
  });

  it("handles a missing modules directory gracefully", () => {
    const missing = join(tmpdir(), `nonexistent-${Date.now()}`);
    const result = discoverBuiltinModules(missing);
    expect(result).toEqual([]);
  });

  it("only registers subdirectories that contain an index.ts", () => {
    const tmp = mkdtempSync(join(tmpdir(), "appstrate-modules-"));
    try {
      // Subdirectory WITH index.ts → should register
      mkdirSync(join(tmp, "alpha"));
      writeFileSync(join(tmp, "alpha", "index.ts"), "export default {};");

      // Subdirectory WITHOUT index.ts → should skip
      mkdirSync(join(tmp, "beta"));
      writeFileSync(join(tmp, "beta", "other.ts"), "export default {};");

      // Stray file at top level → should skip
      writeFileSync(join(tmp, "README.md"), "# docs");

      const discovered = discoverBuiltinModules(tmp);
      expect(discovered).toContain("alpha");
      expect(discovered).not.toContain("beta");
      expect(discovered).not.toContain("README.md");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
