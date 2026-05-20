// SPDX-License-Identifier: Apache-2.0

/**
 * prepareBundleForPi — takes a {@link Bundle} and materialises the
 * on-disk layout the Pi SDK expects (`.pi/skills/`), then returns the
 * {@link ExtensionFactory}s for the agent's selected built-in runtime
 * tools (output/log/note/pin/report).
 *
 * Provider packages are surfaced through the same `.pi/skills/` tree as
 * regular skills (one synthesised SKILL.md per provider, see
 * {@link synthesizeProviderSkill}) so Pi's `loadSkills()` lists them in
 * `<available_skills>` with the read-before-use directive the LLM follows.
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
import {
  ProviderSkillSynthesisError,
  synthesizeProviderSkill,
} from "./provider-skill-synthesis.ts";
import { selectBuiltinRuntimeToolFactories } from "./runtime-tools/builtin/index.ts";

export interface PrepareBundleOptions {
  /**
   * Agent workspace directory. The helper writes:
   *   - `{workspaceDir}/.pi/skills/<packageId>/**`               (for Pi SDK skill discovery)
   *   - `{workspaceDir}/.pi/skills/provider-<scope>-<name>/SKILL.md` (synthesised per provider)
   */
  workspaceDir: string;
  /**
   * Wrap each factory — e.g. {@link wrapExtensionFactory} from
   * runtime-pi which catches tool execute() errors. Return the input
   * untouched to disable wrapping.
   */
  extensionWrapper?: (factory: ExtensionFactory, extensionId: string) => ExtensionFactory;
  /**
   * Notified when a dep package fails to materialise (e.g. provider
   * skill synthesis). The helper does NOT throw on per-package failures
   * — it logs via this callback and continues so one broken package does
   * not prevent the run.
   */
  onError?: (message: string, err?: unknown) => void;
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
  const onError = opts.onError ?? (() => {});
  const piDir = path.join(opts.workspaceDir, ".pi");

  // ─── Step 1: materialise each dep package under its .pi/ subtree ───
  for (const [identity, pkg] of bundle.packages) {
    if (identity === bundle.root) continue;
    const parsed = parsePackageIdentity(identity);
    if (!parsed) continue;
    const type = (pkg.manifest as { type?: unknown }).type;
    if (type === "skill") {
      await materialisePackage(pkg, path.join(piDir, "skills", parsed.packageId));
    } else if (type === "provider") {
      try {
        const { skillName, content } = synthesizeProviderSkill(pkg);
        const skillDir = path.join(piDir, "skills", skillName);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, "SKILL.md"), content);
      } catch (err) {
        const detail =
          err instanceof ProviderSkillSynthesisError || err instanceof Error
            ? err.message
            : String(err);
        onError(`Failed to synthesise provider skill for '${parsed.packageId}': ${detail}`, err);
      }
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
