// SPDX-License-Identifier: Apache-2.0

/**
 * prepareBundleForPi — takes a {@link Bundle} and materialises the on-disk
 * layout the Pi SDK expects (`.pi/skills/`).
 *
 * The platform runtime tools (`output` / `log` / `note` / `pin` / `report`)
 * are NO LONGER registered here. They are transport-neutral MCP tool
 * definitions (`@appstrate/core/runtime-tool-defs`) hosted either by the
 * sidecar (served over `/mcp`) or — on the no-sidecar path — registered as
 * Pi extensions via {@link buildRuntimeToolExtensions} at the call site
 * (`runtime-pi/entrypoint.ts` skip-sidecar branch + the `appstrate run`
 * CLI). This helper is now skills-only.
 *
 * Used by:
 *   1. `runtime-pi/entrypoint.ts` — the in-container agent bootloader.
 *   2. `apps/cli/src/commands/run.ts` — the public CLI runner (out-of-
 *      container, uses a temp dir as workspace).
 *
 * Idempotent on `workspaceDir`: safe to call against an existing
 * workspace — files are overwritten, directories created with
 * `{ recursive: true }`.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Bundle, BundlePackage } from "@appstrate/afps-runtime/bundle";
import { parsePackageIdentity } from "@appstrate/afps-runtime/bundle";

export interface PrepareBundleOptions {
  /**
   * Agent workspace directory. The helper writes:
   *   - `{workspaceDir}/.pi/skills/<packageId>/**`  (for Pi SDK skill discovery)
   */
  workspaceDir: string;
}

export async function prepareBundleForPi(
  bundle: Bundle,
  opts: PrepareBundleOptions,
): Promise<void> {
  const piDir = path.join(opts.workspaceDir, ".pi");

  // Materialise each skill dep package under its .pi/ subtree. Runtime tools
  // (output/log/note/pin) are NOT handled here — they are MCP tool
  // definitions (`@appstrate/core/runtime-tool-defs`) hosted by the sidecar or
  // registered as Pi extensions by the no-sidecar call site via
  // `buildRuntimeToolExtensions`. This helper is skills-only.
  for (const [identity, pkg] of bundle.packages) {
    if (identity === bundle.root) continue;
    const parsed = parsePackageIdentity(identity);
    if (!parsed) continue;
    const type = (pkg.manifest as { type?: unknown }).type;
    if (type === "skill") {
      await materialisePackage(pkg, path.join(piDir, "skills", parsed.packageId));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write every file of a {@link BundlePackage} into `destDir`. The
 * `RECORD` file is stripped since it is a packaging artefact, not part
 * of the executable surface.
 */
async function materialisePackage(pkg: BundlePackage, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  for (const [relative, bytes] of pkg.files) {
    if (relative === "RECORD") continue;
    if (!relative || relative.endsWith("/")) continue;
    const target = path.join(destDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}
