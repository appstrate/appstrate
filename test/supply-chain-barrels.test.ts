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
 * value export (used synchronously at tool-registration time), while the five
 * heavy `pi-coding-agent` values (`ModelRuntime`, `createAgentSession`,
 * `DefaultResourceLoader`, `SessionManager`, `SettingsManager`)
 * are reachable only through the `loadPiCodingAgentSdk()` dynamic loader that
 * keeps them out of the eager bundle graph. So the test asserts the static
 * `Type` + `loadPiCodingAgentSdk` handle exist on the barrel, then drives the
 * loader and asserts every heavy value is defined on the resolved module.
 *
 * Type-only re-exports cannot be checked at runtime (they erase to nothing);
 * they are covered by `tsc` on each barrel's real consumers — e.g. the
 * `apps/cli` barrel is pure type-only (`Api`, `Model`), and
 * `apps/cli/src/commands/run/model.ts` would fail to typecheck if those
 * re-exports went missing. That is why `apps/cli/src/lib/pi-sdk.ts` — the fourth
 * barrel — has no case here: it has no value export to reach for.
 *
 * Imported via relative paths (not package names) because the barrels are
 * package-internal files, not part of any package's `exports` map. This file
 * lives at the repo root `test/` dir intentionally: it is outside every
 * package's tsc `include`, so importing the barrels of several packages in one
 * file introduces no cross-package tsc coupling.
 */

import { describe, it, expect } from "bun:test";

import * as runnerPiBarrel from "../packages/runner-pi/src/pi-sdk.ts";
import * as runtimePiBarrel from "../runtime-pi/pi-sdk.ts";
import * as sidecarPiBarrel from "../runtime-pi/sidecar/pi-sdk.ts";

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
      "ModelRuntime",
      "createAgentSession",
      "DefaultResourceLoader",
      "SessionManager",
      "SettingsManager",
    ] as const;

    const sdk = (await runnerPiBarrel.loadPiCodingAgentSdk()) as Record<string, unknown>;

    for (const name of expectedValues) {
      expect(sdk[name], `runner-pi pi-sdk loader is missing value export "${name}"`).toBeDefined();
    }
  });

  it("runtime-pi barrel re-exports the value symbols its consumers import", () => {
    const barrel = runtimePiBarrel as Record<string, unknown>;

    for (const name of ["Type", "streamSimple"] as const) {
      expect(
        barrel[name],
        `runtime-pi pi-sdk barrel is missing value export "${name}"`,
      ).toBeDefined();
    }
  });

  it("runtime-pi sidecar barrel dispatches to a pi-ai stream for every alias backing shape", () => {
    const barrel = sidecarPiBarrel as Record<string, unknown>;

    // The sidecar barrel does not re-export the vendor symbols verbatim: it
    // imports `streamSimple` from each `pi-ai/api/*` protocol entrypoint and
    // folds them into one `streamBacking` dispatcher. A backing whose vendor
    // entrypoint stopped exporting `streamSimple` therefore shows up as a
    // missing dispatch, not as a missing re-export — which is what this asserts.
    expect(
      barrel.streamBacking,
      'sidecar pi-sdk barrel is missing value export "streamBacking"',
    ).toBeDefined();

    for (const api of [
      "anthropic-messages",
      "mistral-conversations",
      "openai-codex-responses",
      "openai-completions",
      "openai-responses",
    ] as const) {
      let thrown: unknown;
      try {
        sidecarPiBarrel.streamBacking({ api } as never, {} as never, {} as never);
      } catch (error) {
        // A vendor stream rejecting the empty stub context is expected and
        // irrelevant here; only the barrel's own "no implementation" error is.
        thrown = error;
      }
      expect(
        thrown instanceof Error ? thrown.message : "",
        `sidecar pi-sdk barrel has no pi-ai stream implementation for backing "${api}"`,
      ).not.toContain("no pi-ai stream implementation");
    }
  });
});
