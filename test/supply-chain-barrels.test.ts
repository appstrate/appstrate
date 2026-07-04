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
 * VALUE symbols consumers use are actually reachable at runtime. The
 * `@appstrate/runner-pi` barrel splits that surface: `Type` stays a static
 * value export (used synchronously at tool-registration time), while the six
 * heavy `pi-coding-agent` values (`AuthStorage`, `createAgentSession`,
 * `DefaultResourceLoader`, `ModelRegistry`, `SessionManager`, `SettingsManager`)
 * are reachable only through the `loadPiCodingAgentSdk()` dynamic loader that
 * keeps them out of the eager bundle graph. So the test asserts the static
 * `Type` + `loadPiCodingAgentSdk` handle exist on the barrel, then drives the
 * loader and asserts every heavy value is defined on the resolved module.
 *
 * Type-only re-exports cannot be checked at runtime (they erase to nothing);
 * they are covered by `tsc` on each barrel's real consumers — e.g. the
 * `apps/cli` barrel is pure type-only (`Api`, `Model`), and
 * `apps/cli/src/commands/run/model.ts` would fail to typecheck if those
 * re-exports went missing.
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

describe("supply-chain: pi-sdk barrel completeness", () => {
  it("@appstrate/runner-pi barrel exposes the static Type value and the SDK loader handle", () => {
    const barrel = runnerPiBarrel as Record<string, unknown>;

    expect(barrel.Type, 'runner-pi pi-sdk barrel is missing value export "Type"').toBeDefined();
    expect(
      barrel.loadPiCodingAgentSdk,
      'runner-pi pi-sdk barrel is missing value export "loadPiCodingAgentSdk"',
    ).toBeDefined();
  });

  it("@appstrate/runner-pi loadPiCodingAgentSdk() resolves every heavy value its consumers import", async () => {
    const expectedValues = [
      "AuthStorage",
      "createAgentSession",
      "DefaultResourceLoader",
      "ModelRegistry",
      "SessionManager",
      "SettingsManager",
    ] as const;

    const sdk = (await runnerPiBarrel.loadPiCodingAgentSdk()) as Record<string, unknown>;

    for (const name of expectedValues) {
      expect(sdk[name], `runner-pi pi-sdk loader is missing value export "${name}"`).toBeDefined();
    }
  });

  it("runtime-pi barrel re-exports the value symbol its consumers import", () => {
    expect(
      (runtimePiBarrel as Record<string, unknown>).Type,
      'runtime-pi pi-sdk barrel is missing value export "Type"',
    ).toBeDefined();
  });
});
