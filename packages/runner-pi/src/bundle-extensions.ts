// SPDX-License-Identifier: Apache-2.0

/**
 * prepareBundleForPi — takes a {@link LoadedBundle} and materialises
 * the on-disk layout the Pi SDK expects (`.pi/skills/`, `.pi/providers/`,
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
 * `import()` on file paths. We write any tool-scoped file
 * (`tools/<id>/**`) into the workspace `.agent-tools/<id>/` subtree so
 * multi-file tools (shared helpers, fixtures, etc.) resolve correctly
 * relative to their entrypoint.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { LoadedBundle } from "@appstrate/afps-runtime/bundle";

export interface PrepareBundleOptions {
  /**
   * Agent workspace directory. The helper writes:
   *   - `{workspaceDir}/.pi/skills/**`           (for Pi SDK skill discovery)
   *   - `{workspaceDir}/.pi/providers/**`        (for Pi SDK provider discovery)
   *   - `{workspaceDir}/.pi/tools/<id>/TOOL.md`  (for Pi SDK tool docs)
   *   - `{workspaceDir}/.agent-tools/<id>/**`    (tool source, dynamic-imported)
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
 * Parse bundle manifest and materialise the `.pi/` + `.agent-tools/`
 * layout required by the Pi SDK, then dynamic-import each tool's
 * entrypoint into an ExtensionFactory.
 *
 * Idempotent on `workspaceDir`: safe to call against an existing
 * workspace — files are overwritten, directories created with
 * `{ recursive: true }`.
 */
export async function prepareBundleForPi(
  bundle: LoadedBundle,
  opts: PrepareBundleOptions,
): Promise<PreparedBundle> {
  const onError = opts.onError ?? (() => {});
  const piDir = path.join(opts.workspaceDir, ".pi");
  const toolsScratchDir = path.join(opts.workspaceDir, ".agent-tools");

  // ─── Step 1: install skills/ and providers/ under .pi/ ───────────
  await Promise.all([
    materialiseDir(bundle, "skills/", path.join(piDir, "skills")),
    materialiseDir(bundle, "providers/", path.join(piDir, "providers")),
  ]);

  // ─── Step 2: resolve tool dependency list from manifest ──────────
  const manifest = bundle.manifest as { dependencies?: { tools?: Record<string, string> } };
  const toolDeps = manifest.dependencies?.tools ?? {};
  const toolIds = Object.keys(toolDeps);

  const factories: ExtensionFactory[] = [];
  const loadedIds = new Set<string>();

  for (const toolId of toolIds) {
    try {
      const { factory, resolvedId } = await loadToolFromBundle(
        bundle,
        toolId,
        toolsScratchDir,
        piDir,
      );
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

/**
 * Write every bundle entry whose path starts with `prefix` into `destDir`,
 * stripping the prefix. No-op when the bundle has no matching entries.
 */
async function materialiseDir(
  bundle: LoadedBundle,
  prefix: string,
  destDir: string,
): Promise<void> {
  const entries = Object.entries(bundle.files).filter(([p]) => p.startsWith(prefix));
  if (entries.length === 0) return;

  await fs.mkdir(destDir, { recursive: true });
  for (const [p, bytes] of entries) {
    const relative = p.slice(prefix.length);
    if (!relative || relative.endsWith("/")) continue;
    const target = path.join(destDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}

/**
 * Load a single tool from the bundle:
 *   1. Copy every `tools/<toolId>/**` file into `.agent-tools/<toolId>/`
 *      so the dynamic-imported entrypoint can resolve relative deps.
 *   2. Parse `tools/<toolId>/manifest.json` to find the entrypoint file
 *      and the canonical name for dedup (manifest.tool.name || toolId).
 *   3. Copy `tools/<toolId>/TOOL.md` (when present) under
 *      `.pi/tools/<toolId>/` for Pi SDK docs discovery.
 *   4. Dynamic-import the entrypoint absolute path, verify `default`
 *      is a function, return it as the ExtensionFactory.
 *
 * Returns `{ factory: null }` for well-formed skips (missing manifest,
 * missing entrypoint) so the caller counts them separately from loader
 * failures (which throw).
 */
async function loadToolFromBundle(
  bundle: LoadedBundle,
  toolId: string,
  toolsScratchDir: string,
  piDir: string,
): Promise<{ factory: ExtensionFactory | null; resolvedId: string }> {
  const toolPrefix = `tools/${toolId}/`;
  const toolFiles = Object.entries(bundle.files).filter(([p]) => p.startsWith(toolPrefix));
  if (toolFiles.length === 0) {
    return { factory: null, resolvedId: toolId };
  }

  // 1. Write tool files to scratch dir
  const toolScratchRoot = path.join(toolsScratchDir, toolId);
  await fs.mkdir(toolScratchRoot, { recursive: true });
  for (const [p, bytes] of toolFiles) {
    const relative = p.slice(toolPrefix.length);
    if (!relative || relative.endsWith("/")) continue;
    const target = path.join(toolScratchRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }

  // 2. Read manifest
  const manifestBytes = bundle.files[`${toolPrefix}manifest.json`];
  if (!manifestBytes) {
    return { factory: null, resolvedId: toolId };
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    entrypoint?: string;
    tool?: { name?: string };
  };
  const entrypoint = manifest.entrypoint;
  if (!entrypoint) {
    return { factory: null, resolvedId: toolId };
  }
  const resolvedId = manifest.tool?.name ?? toolId;

  // 3. Copy TOOL.md (if present) to .pi/tools/<toolId>/TOOL.md
  const toolMdBytes = bundle.files[`${toolPrefix}TOOL.md`];
  if (toolMdBytes) {
    const toolMdDir = path.join(piDir, "tools", toolId);
    await fs.mkdir(toolMdDir, { recursive: true });
    await fs.writeFile(path.join(toolMdDir, "TOOL.md"), toolMdBytes);
  }

  // 4. Dynamic-import the entrypoint
  const entrypointPath = path.join(toolScratchRoot, entrypoint);
  const mod: unknown = await import(entrypointPath);
  const factory = (mod as { default?: unknown }).default;
  if (typeof factory !== "function") {
    throw new Error(
      `Tool '${toolId}' entrypoint '${entrypoint}' default export is not a function (got ${typeof factory})`,
    );
  }
  return { factory: factory as ExtensionFactory, resolvedId };
}
