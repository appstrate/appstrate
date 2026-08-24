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

/**
 * Every VALUE symbol imported from `<dir>/**\/<barrel>` by the files under
 * `dir`, read from the source.
 *
 * Type-only imports are excluded on both spellings — a whole `import type {…}`
 * statement, and a `type X` specifier inside a value import — because they
 * erase at runtime and a missing type re-export surfaces as a tsc error on the
 * consumer instead (see the module doc).
 *
 * Deliberately regex over the source rather than a TS AST: this file is outside
 * every package's tsc program by design, and pulling a parser in to read five
 * import statements would undo that.
 *
 * The specifier body is `[^}]*` and NOT `[\s\S]*?`. The lazy any-character
 * form crosses statement boundaries: it anchors on the FIRST `import {` in the
 * file and runs to the barrel import's closing brace, so the captured list
 * holds several statements' specifiers and the `(type\s+)?` group reports on
 * the wrong one — an `import type { Api, Model } from "./pi-sdk.ts"` preceded
 * by any value import reads as a value import. A specifier list contains no
 * braces, so `[^}]*` cannot leave its own statement. It still spans newlines,
 * which is what prettier's wrapping needs.
 */
async function valueImportsOfBarrel(
  dir: string,
  barrelFile: string,
  skipDirs: readonly string[] = [],
): Promise<string[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const found = new Set<string>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name) || entry.name === "node_modules") continue;
        await walk(join(current, entry.name));
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name === barrelFile) continue;
      const source = await readFile(join(current, entry.name), "utf8");
      const pattern = new RegExp(
        `import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+"[./]*${barrelFile.replace(".", "\\.")}"`,
        "g",
      );
      for (const match of source.matchAll(pattern)) {
        if (match[1]) continue; // `import type { … }` — erased at runtime
        for (const raw of (match[2] ?? "").split(",")) {
          const specifier = raw.trim();
          if (!specifier || specifier.startsWith("type ")) continue;
          found.add((specifier.split(/\s+as\s+/)[0] ?? "").trim());
        }
      }
    }
  };
  await walk(dir);
  return [...found].filter(Boolean).sort();
}

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

  it("runtime-pi barrel re-exports the value symbols its consumers import", async () => {
    // DERIVED, not hardcoded. A literal list is a second statement of "what
    // consumers import" that drifts from the first: this case carried
    // `streamSimple` after its last consumer stopped importing it from the
    // barrel, so the test demanded an export nothing needed — and would
    // equally have stayed silent about a symbol a new consumer started
    // importing. Reading the imports is the only version that tracks.
    const imported = await valueImportsOfBarrel(
      new URL("../runtime-pi", import.meta.url).pathname,
      "pi-sdk.ts",
      ["sidecar"], // the sidecar has its own barrel, asserted below
    );

    // Positive control: an empty or truncated scan must not pass vacuously.
    expect(
      imported,
      "no consumer of the runtime-pi barrel was found — the scan is broken",
    ).toContain("Type");

    const barrel = runtimePiBarrel as Record<string, unknown>;
    for (const name of imported) {
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
