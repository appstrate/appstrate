// SPDX-License-Identifier: Apache-2.0

/**
 * Barrel-completeness guard for the single-vendor Pi SDK.
 *
 * The "one-file swap" guarantee in docs/architecture/SUPPLY_CHAIN.md assumes each
 * `pi-sdk.ts` barrel re-exports EVERY symbol its consumers import. The ESLint
 * `no-restricted-imports` guard cannot catch a *missing* re-export — that surfaces
 * only as a runtime `undefined` (for values) or a tsc error (for types).
 *
 * This test closes the runtime half: it imports each barrel and asserts the
 * VALUE symbols consumers use are actually defined at runtime. Type-only
 * re-exports cannot be checked at runtime (they erase to nothing); they are
 * covered by `tsc` on each barrel's real consumers — e.g. the `apps/cli` barrel
 * is pure type-only (`Api`, `Model`), and `apps/cli/src/commands/run/model.ts`
 * would fail to typecheck if those re-exports went missing.
 *
 * Imported via relative paths (not package names) because the barrels are
 * package-internal files, not part of any package's `exports` map. This file
 * lives at the repo root `test/` dir intentionally: it is outside every
 * package's tsc `include`, so importing three barrels from three packages in one
 * file introduces no cross-package tsc coupling.
 */

import { describe, it, expect } from "bun:test";

import * as runnerPiBarrel from "../packages/runner-pi/src/pi-sdk.ts";
import * as runtimePiBarrel from "../runtime-pi/pi-sdk.ts";
// Pure type-only barrel — at runtime this is an empty module object. Imported to
// prove it loads; its symbol completeness (Api, Model) is enforced by tsc on its
// real consumer (apps/cli/src/commands/run/model.ts).
import * as cliBarrel from "../apps/cli/src/lib/pi-sdk.ts";

describe("supply-chain: pi-sdk barrel completeness", () => {
  it("@appstrate/runner-pi barrel re-exports every value symbol its consumers import", () => {
    const expectedValues = [
      "AuthStorage",
      "createAgentSession",
      "DefaultResourceLoader",
      "ModelRegistry",
      "SessionManager",
      "SettingsManager",
      "Type",
    ] as const;

    for (const name of expectedValues) {
      expect(
        (runnerPiBarrel as Record<string, unknown>)[name],
        `runner-pi pi-sdk barrel is missing value export "${name}"`,
      ).toBeDefined();
    }
  });

  it("runtime-pi barrel re-exports the value symbol its consumers import", () => {
    expect(
      (runtimePiBarrel as Record<string, unknown>).Type,
      'runtime-pi pi-sdk barrel is missing value export "Type"',
    ).toBeDefined();
  });

  it("@appstrate/cli barrel is type-only (no runtime value exports) and loads cleanly", () => {
    // No value exports to assert — type completeness (Api, Model) is a tsc concern,
    // enforced on the barrel's real consumer. Loading without throwing is the check.
    expect(cliBarrel).toBeDefined();
  });
});
