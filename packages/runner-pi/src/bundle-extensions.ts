// SPDX-License-Identifier: Apache-2.0

/**
 * prepareBundleForPi — takes a {@link Bundle} and materialises its skill and
 * integration members on disk (`.pi/skills/`, `.pi/integrations/`), where the
 * prompt tells the agent to read them.
 *
 * Runtime tools (`output` / `log` / `note` / `pin`) are not registered here:
 * they are transport-neutral MCP tool definitions
 * (`@appstrate/core/runtime-tool-defs`) hosted by the sidecar (over `/mcp`)
 * or, in the `appstrate run` CLI, registered as Pi extensions via
 * {@link buildRuntimeToolExtensions} at the call site.
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
import type { Bundle, BundlePackage, PackageIdentity } from "@appstrate/afps-runtime/bundle";
import {
  PI_INTEGRATIONS_DIR,
  PI_SKILLS_DIR,
  parsePackageIdentity,
} from "@appstrate/afps-runtime/bundle";

export interface PrepareBundleOptions {
  /**
   * Agent workspace directory. The helper writes:
   *   - `{workspaceDir}/.pi/skills/<packageId>/**`        (skill members)
   *   - `{workspaceDir}/.pi/integrations/<packageId>/**`  (integration members)
   */
  workspaceDir: string;
}

/** Where a workspace's skills live: `{workspaceDir}/.pi/skills/<packageId>/`. */
export function piSkillsDir(workspaceDir: string): string {
  return path.join(workspaceDir, PI_SKILLS_DIR);
}

/** Member types written to the workspace, keyed to their workspace-relative dir. */
const MATERIALISED_DIRS: ReadonlyMap<unknown, string> = new Map([
  ["skill", PI_SKILLS_DIR],
  ["integration", PI_INTEGRATIONS_DIR],
]);

/**
 * Absolute directory a bundle member is materialised into, or `null` when its
 * type is not written to the workspace (agents, unknown types) or its identity
 * does not parse. Shared by the materialiser and the entrypoint's post-check
 * so both agree on where a member must land.
 */
export function bundleMemberDir(
  workspaceDir: string,
  identity: PackageIdentity,
  pkg: BundlePackage,
): string | null {
  const dir = MATERIALISED_DIRS.get((pkg.manifest as { type?: unknown }).type);
  if (!dir) return null;
  const parsed = parsePackageIdentity(identity);
  if (!parsed) return null;
  return path.join(workspaceDir, dir, parsed.packageId);
}

export async function prepareBundleForPi(
  bundle: Bundle,
  opts: PrepareBundleOptions,
): Promise<void> {
  for (const [identity, pkg] of bundle.packages) {
    if (identity === bundle.root) continue;
    const destDir = bundleMemberDir(opts.workspaceDir, identity, pkg);
    if (destDir) await materialisePackage(pkg, destDir);
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
