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
 * In a published AFPS archive, `manifest.entrypoint` points at a
 * self-contained, pre-bundled ESM artifact (AFPS §3.4). The runner
 * does NOT resolve bare-specifier imports against an ambient
 * `node_modules/` tree — every runtime dep other than the Pi SDK
 * pair is inlined into the emitted file at publish time by
 * `@appstrate/core/tool-bundler`. A package whose `entrypoint` is
 * missing or unreadable is rejected at load with a clear error so
 * the problem surfaces at the package boundary, not at tool-call time.
 *
 * The helper is FS-bound because Bun/Node only supports dynamic
 * `import()` on file paths. We write the entrypoint file into the
 * workspace `.agent-tools/<id>/` subtree so the import path is stable.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Bundle, BundlePackage } from "@appstrate/afps-runtime/bundle";
import { parsePackageIdentity, resolveToolEntrypoint } from "@appstrate/afps-runtime/bundle";

/**
 * The only package names Appstrate-bundled tool entrypoints keep as
 * external imports (see `@appstrate/core/tool-bundler`). When we place
 * the tool scratch dir inside a tree walkable to a `node_modules/`
 * that contains these two packages, every bundled entrypoint can
 * `import` against the runner's own copy — no per-workspace symlink
 * required.
 */
const PI_SDK_EXTERNAL_PACKAGES = ["@mariozechner/pi-ai", "@mariozechner/pi-coding-agent"] as const;

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
   * Absolute path of the scratch dir where tool entrypoints were
   * materialised. Useful for tests and debug logging — callers should
   * prefer {@link cleanup} for teardown.
   */
  toolsScratchDir: string;
  /**
   * Remove the tool scratch directory created by the helper. Safe to
   * call multiple times. Does NOT touch `.pi/` — that subtree is
   * considered part of the workspace contract.
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

  // Tool entrypoints leave two package names external — the Pi SDK
  // pair. They must still resolve at runtime when Bun/Node dynamic-
  // imports the entrypoint file. The resolver walks up from the file's
  // location looking for an ancestor `node_modules/`, so we pick a
  // scratch dir beneath the runner's own `node_modules/` when we can
  // find one. Falls back to `<workspaceDir>/.agent-tools/` otherwise;
  // runners that use that fallback (the Docker runtime image) must
  // arrange for `@mariozechner/pi-ai` + `@mariozechner/pi-coding-agent`
  // to resolve from the workspace themselves (e.g. a node_modules symlink).
  const sdkNodeModules = await findPiSdkNodeModules();
  const toolsScratchDir = sdkNodeModules
    ? path.join(sdkNodeModules, ".cache", "appstrate-tools", `run-${process.pid}-${Date.now()}`)
    : path.join(opts.workspaceDir, ".agent-tools");

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
      const detail = err instanceof Error ? err.message : String(err);
      onError(`Failed to load tool '${toolId}': ${detail}`, err);
    }
  }

  return {
    extensionFactories: factories,
    toolsScratchDir,
    cleanup: async () => {
      await fs.rm(toolsScratchDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from this module's directory looking for the nearest
 * `node_modules/` that contains every Pi SDK external. Returns that
 * `node_modules/` path or null if no ancestor has the full set
 * installed — in which case callers fall back to writing the tool
 * scratch into `workspaceDir/.agent-tools/`.
 */
async function findPiSdkNodeModules(): Promise<string | null> {
  let dir = import.meta.dir;
  for (;;) {
    const candidate = path.join(dir, "node_modules");
    const allPresent = await Promise.all(
      PI_SDK_EXTERNAL_PACKAGES.map((pkg) =>
        fs
          .stat(path.join(candidate, pkg))
          .then(() => true)
          .catch(() => false),
      ),
    ).then((r) => r.every(Boolean));
    if (allPresent) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

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
 * Load a single tool from its {@link BundlePackage}.
 *
 * Contract:
 *   - `manifest.entrypoint` MUST point at a file the runner can load
 *     with no further build step. In published archives this is a
 *     self-contained bundle (see `@appstrate/core/tool-bundler`).
 *   - A package with a missing or unreadable entrypoint is rejected
 *     here; the caller logs via `onError` and the run proceeds without
 *     the tool. We do NOT fall back to any heuristic (source `.ts` at
 *     a conventional path, etc.) — that silently depends on an ambient
 *     `node_modules/` the runner is not supposed to know about.
 *
 * Steps:
 *   1. Write the entrypoint file to `.agent-tools/<packageId>/`
 *      (the only file the runner needs at runtime).
 *   2. Copy `TOOL.md` (when present) under `.pi/tools/<packageId>/`
 *      for Pi SDK docs discovery.
 *   3. Dynamic-import the entrypoint, verify `default` is a function,
 *      return it as the ExtensionFactory.
 */
async function loadToolFromPackage(
  pkg: BundlePackage,
  toolsScratchDir: string,
  piDir: string,
): Promise<{ factory: ExtensionFactory | null; resolvedId: string }> {
  const parsed = parsePackageIdentity(pkg.identity);
  const fallbackId = parsed?.packageId ?? pkg.identity;
  const resolvedId = (pkg.manifest as { tool?: { name?: string } }).tool?.name ?? fallbackId;

  // Per AFPS §3.4: `manifest.entrypoint` is the single runtime contract.
  // `resolveToolEntrypoint` throws AfpsEntrypointError on missing/unsafe
  // path/absent file; we let it propagate to the caller which logs via
  // `onError` and continues without this tool.
  const { entrypoint, bytes: entrypointBytes } = resolveToolEntrypoint(pkg, fallbackId);

  // 1. Write the entrypoint to scratch dir
  const toolScratchRoot = path.join(toolsScratchDir, fallbackId);
  const entrypointDest = path.join(toolScratchRoot, entrypoint);
  await fs.mkdir(path.dirname(entrypointDest), { recursive: true });
  await fs.writeFile(entrypointDest, entrypointBytes);

  // 2. Copy TOOL.md (if present) to .pi/tools/<packageId>/TOOL.md
  const toolMdBytes = pkg.files.get("TOOL.md");
  if (toolMdBytes) {
    const toolMdDir = path.join(piDir, "tools", fallbackId);
    await fs.mkdir(toolMdDir, { recursive: true });
    await fs.writeFile(path.join(toolMdDir, "TOOL.md"), toolMdBytes);
  }

  // 3. Dynamic-import the entrypoint
  const mod: unknown = await import(entrypointDest);
  const factory = (mod as { default?: unknown }).default;
  if (typeof factory !== "function") {
    throw new Error(
      `Tool '${fallbackId}' entrypoint '${entrypoint}' default export is not a function (got ${typeof factory})`,
    );
  }
  return { factory: factory as ExtensionFactory, resolvedId };
}
