// SPDX-License-Identifier: Apache-2.0

/**
 * prepareBundleForPi — takes a {@link Bundle} and materialises the
 * on-disk layout the Pi SDK expects (`.pi/skills/`), then returns the
 * {@link ExtensionFactory}s for the agent's selected built-in runtime
 * tools (output/log/note/pin/report).
 *
 * Tools are no longer AFPS packages: the former `@appstrate/{output,log,
 * note,pin,report}` tool packages are baked into the runtime image
 * (`./runtime-tools/builtin/`). `output` is always injected; the rest are
 * opt-in via the agent manifest's `runtimeTools[]` field.
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
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Bundle, BundlePackage } from "@appstrate/afps-runtime/bundle";
import { parsePackageIdentity } from "@appstrate/afps-runtime/bundle";
import { selectBuiltinRuntimeToolFactories } from "./runtime-tools/builtin/index.ts";

export interface PrepareBundleOptions {
  /**
   * Agent workspace directory. The helper writes:
   *   - `{workspaceDir}/.pi/skills/<packageId>/**`  (for Pi SDK skill discovery)
   */
  workspaceDir: string;
  /**
   * Wrap each factory — e.g. {@link wrapExtensionFactory} from
   * runtime-pi which catches tool execute() errors. Return the input
   * untouched to disable wrapping.
   */
  extensionWrapper?: (factory: ExtensionFactory, extensionId: string) => ExtensionFactory;
}

export interface PreparedBundle {
  /** Factories ready to pass to `PiRunner({ extensionFactories })`. */
  extensionFactories: ExtensionFactory[];
  /**
   * Teardown hook. Retained for API stability (built-in runtime tools
   * need no scratch dir, so this is currently a no-op). Does NOT touch
   * `.pi/` — that subtree is part of the workspace contract.
   */
  cleanup: () => Promise<void>;
}

export async function prepareBundleForPi(
  bundle: Bundle,
  opts: PrepareBundleOptions,
): Promise<PreparedBundle> {
  const piDir = path.join(opts.workspaceDir, ".pi");

  // ─── Step 1: materialise each skill dep package under its .pi/ subtree ─
  for (const [identity, pkg] of bundle.packages) {
    if (identity === bundle.root) continue;
    const parsed = parsePackageIdentity(identity);
    if (!parsed) continue;
    const type = (pkg.manifest as { type?: unknown }).type;
    if (type === "skill") {
      await materialisePackage(pkg, path.join(piDir, "skills", parsed.packageId));
    }
  }

  // ─── Step 2: register selected built-in runtime tools ────────────
  // Tools (output/log/note/pin/report) are no longer AFPS packages —
  // they are baked into the runtime image. `output` is always injected;
  // the rest are opt-in via the agent manifest's `runtimeTools[]`.
  const rootPkg = bundle.packages.get(bundle.root);
  const rootManifest = (rootPkg?.manifest ?? {}) as { runtimeTools?: string[] };

  const factories: ExtensionFactory[] = [];
  for (const { id, factory } of selectBuiltinRuntimeToolFactories(rootManifest.runtimeTools)) {
    const wrapped = opts.extensionWrapper ? opts.extensionWrapper(factory, id) : factory;
    factories.push(wrapped);
  }

  return {
    extensionFactories: factories,
    cleanup: async () => {},
  };
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
