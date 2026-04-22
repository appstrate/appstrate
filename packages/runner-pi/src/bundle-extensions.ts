// SPDX-License-Identifier: Apache-2.0

/**
 * prepareBundleForPi — takes a {@link Bundle} and materialises the
 * on-disk layout the Pi SDK expects (`.pi/skills/`, `.pi/providers/`,
 * `.pi/tools/<id>/TOOL.md`), dynamic-imports every `dependencies.tools`
 * entrypoint, and returns the resulting {@link ExtensionFactory}s.
 *
 * Used by:
 *   1. `runtime-pi/entrypoint.ts` — the in-container agent bootloader.
 *   2. `apps/cli/src/commands/run.ts` — the public CLI runner (out-of-
 *      container, uses a temp dir as workspace).
 *
 * Having a single helper means both code paths load tools with
 * identical semantics: same manifest parsing, same dedup rules, same
 * wrapper chain. A bug fix lands in both places simultaneously.
 *
 * The helper is FS-bound because Bun/Node only supports dynamic
 * `import()` on file paths. We write any tool-scoped file into the
 * workspace `.agent-tools/<id>/` subtree so multi-file tools (shared
 * helpers, fixtures, etc.) resolve correctly relative to their
 * entrypoint.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Bundle, BundlePackage } from "@appstrate/afps-runtime/bundle";
import { parsePackageIdentity } from "@appstrate/afps-runtime/bundle";

export interface PrepareBundleOptions {
  /**
   * Agent workspace directory. The helper writes:
   *   - `{workspaceDir}/.pi/skills/<packageId>/**`      (for Pi SDK skill discovery)
   *   - `{workspaceDir}/.pi/providers/<packageId>/**`   (for Pi SDK provider discovery)
   *   - `{workspaceDir}/.pi/tools/<packageId>/TOOL.md`  (for Pi SDK tool docs)
   *   - `{workspaceDir}/.agent-tools/<packageId>/**`    (tool source, dynamic-imported)
   */
  workspaceDir: string;
  /**
   * Wrap each factory — e.g. {@link wrapExtensionFactory} from
   * runtime-pi which catches tool execute() errors. Return the input
   * untouched to disable wrapping.
   */
  extensionWrapper?: (factory: ExtensionFactory, extensionId: string) => ExtensionFactory;
  /**
   * Notified when a tool fails to load (bad manifest, missing
   * entrypoint, non-function default export, dynamic-import throw).
   * The helper does NOT throw on per-tool failures — it logs via
   * this callback and continues with the remaining tools so a single
   * broken tool does not prevent the run.
   */
  onError?: (message: string, err?: unknown) => void;
}

export interface PreparedBundle {
  /** Factories ready to pass to `PiRunner({ extensionFactories })`. */
  extensionFactories: ExtensionFactory[];
  /**
   * Remove the `.agent-tools/` scratch directory created by the
   * helper. Safe to call multiple times. Does NOT touch `.pi/` — that
   * subtree is considered part of the workspace contract.
   */
  cleanup: () => Promise<void>;
}

/**
 * Parse bundle, partition packages by type, materialise the `.pi/` +
 * `.agent-tools/` layout required by the Pi SDK, then dynamic-import
 * each tool's entrypoint into an ExtensionFactory.
 *
 * Idempotent on `workspaceDir`: safe to call against an existing
 * workspace — files are overwritten, directories created with
 * `{ recursive: true }`.
 */
export async function prepareBundleForPi(
  bundle: Bundle,
  opts: PrepareBundleOptions,
): Promise<PreparedBundle> {
  const onError = opts.onError ?? (() => {});
  const piDir = path.join(opts.workspaceDir, ".pi");
  const toolsScratchDir = path.join(opts.workspaceDir, ".agent-tools");

  // ─── Step 1: materialise each dep package under its .pi/ subtree ───
  for (const [identity, pkg] of bundle.packages) {
    if (identity === bundle.root) continue;
    const parsed = parsePackageIdentity(identity);
    if (!parsed) continue;
    const type = (pkg.manifest as { type?: unknown }).type;
    if (type === "skill") {
      await materialisePackage(pkg, path.join(piDir, "skills", parsed.packageId));
    } else if (type === "provider") {
      await materialisePackage(pkg, path.join(piDir, "providers", parsed.packageId));
    }
    // tool packages are handled in step 2 (need scratch + TOOL.md + dynamic import)
  }

  // ─── Step 2: load each declared tool dep ─────────────────────────
  const rootPkg = bundle.packages.get(bundle.root);
  const rootManifest = (rootPkg?.manifest ?? {}) as {
    dependencies?: { tools?: Record<string, string> };
  };
  const toolDeps = rootManifest.dependencies?.tools ?? {};
  const toolIds = Object.keys(toolDeps);

  const factories: ExtensionFactory[] = [];
  const loadedIds = new Set<string>();

  for (const toolId of toolIds) {
    try {
      const pkg = findPackageByName(bundle, toolId);
      if (!pkg) continue;
      const { factory, resolvedId } = await loadToolFromPackage(pkg, toolsScratchDir, piDir);
      if (factory === null) continue;
      if (loadedIds.has(resolvedId)) continue;
      loadedIds.add(resolvedId);
      const wrapped = opts.extensionWrapper ? opts.extensionWrapper(factory, resolvedId) : factory;
      factories.push(wrapped);
    } catch (err) {
      onError(`Failed to load tool '${toolId}'`, err);
    }
  }

  return {
    extensionFactories: factories,
    cleanup: async () => {
      await fs.rm(toolsScratchDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findPackageByName(bundle: Bundle, name: string): BundlePackage | null {
  for (const pkg of bundle.packages.values()) {
    if ((pkg.manifest as { name?: unknown }).name === name) return pkg;
  }
  return null;
}

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

/**
 * Load a single tool from its {@link BundlePackage}:
 *   1. Copy every file into `.agent-tools/<packageId>/` so dynamic-
 *      imported entrypoint can resolve relative deps.
 *   2. Parse `manifest.json` to find the entrypoint file and the
 *      canonical tool name for dedup.
 *   3. Copy `TOOL.md` (when present) under `.pi/tools/<packageId>/`
 *      for Pi SDK docs discovery.
 *   4. Dynamic-import the entrypoint absolute path, verify `default`
 *      is a function, return it as the ExtensionFactory.
 *
 * Returns `{ factory: null }` for well-formed skips (missing manifest,
 * missing entrypoint) so the caller counts them separately from loader
 * failures (which throw).
 */
async function loadToolFromPackage(
  pkg: BundlePackage,
  toolsScratchDir: string,
  piDir: string,
): Promise<{ factory: ExtensionFactory | null; resolvedId: string }> {
  const parsed = parsePackageIdentity(pkg.identity);
  const fallbackId = parsed?.packageId ?? pkg.identity;

  // 1. Write tool files to scratch dir
  const toolScratchRoot = path.join(toolsScratchDir, fallbackId);
  await fs.mkdir(toolScratchRoot, { recursive: true });
  for (const [relative, bytes] of pkg.files) {
    if (relative === "RECORD") continue;
    if (!relative || relative.endsWith("/")) continue;
    const target = path.join(toolScratchRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }

  // 2. Read manifest (prefer in-memory over file bytes — same content)
  const manifest = pkg.manifest as {
    entrypoint?: string;
    tool?: { name?: string };
  };
  const entrypoint = manifest.entrypoint;
  if (!entrypoint) {
    return { factory: null, resolvedId: fallbackId };
  }
  const resolvedId = manifest.tool?.name ?? fallbackId;

  // 3. Copy TOOL.md (if present) to .pi/tools/<packageId>/TOOL.md
  const toolMdBytes = pkg.files.get("TOOL.md");
  if (toolMdBytes) {
    const toolMdDir = path.join(piDir, "tools", fallbackId);
    await fs.mkdir(toolMdDir, { recursive: true });
    await fs.writeFile(path.join(toolMdDir, "TOOL.md"), toolMdBytes);
  }

  // 4. Dynamic-import the entrypoint
  const entrypointPath = path.join(toolScratchRoot, entrypoint);
  const mod: unknown = await import(entrypointPath);
  const factory = (mod as { default?: unknown }).default;
  if (typeof factory !== "function") {
    throw new Error(
      `Tool '${fallbackId}' entrypoint '${entrypoint}' default export is not a function (got ${typeof factory})`,
    );
  }
  return { factory: factory as ExtensionFactory, resolvedId };
}
