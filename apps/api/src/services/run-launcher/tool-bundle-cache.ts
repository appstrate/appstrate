// SPDX-License-Identifier: Apache-2.0

/**
 * Transforms a draft tool package's raw file map into a runtime-ready
 * file map where `tool.js` is the self-contained ESM bundle and
 * `manifest.entrypoint` points at it.
 *
 * Called on the run hot path by {@link DraftPackageCatalog}. The
 * published path ({@link buildPublishedToolArchive}) already stores
 * bundled archives, so `DbPackageCatalog` does not invoke this helper.
 *
 * Caching is content-addressed and instance-scoped (one cache per
 * {@link DraftPackageCatalog}, which is itself one-per-run). The key
 * hashes every input byte plus the entrypoint path, so two tools with
 * identical source produce one bundle. Inter-run caching (Redis) is
 * intentionally deferred until benchmarks prove it useful.
 */

import { createHash } from "node:crypto";
import { BundleError } from "@appstrate/afps-runtime/bundle";
import {
  bundleTool,
  PUBLISHED_TOOL_BUNDLE_FILENAME,
  ToolBundlerError,
} from "@appstrate/core/tool-bundler";

export interface BundleDraftToolInput {
  /** Archive-relative file map from storage (TOOL.md, tool.ts, manifest.json…). */
  files: Map<string, Uint8Array>;
  /** The draft manifest (read, not mutated). */
  manifest: Record<string, unknown>;
  /** Package identifier (e.g. `@scope/tool`). Used in error messages. */
  toolId: string;
}

export interface BundleDraftToolResult {
  /**
   * New file map: `tool.js` replaces the source, `manifest.json` is
   * rewritten, auxiliary files (`TOOL.md`, assets) are preserved.
   */
  files: Map<string, Uint8Array>;
  /** New manifest with `entrypoint` rewritten to `tool.js`. */
  manifest: Record<string, unknown>;
}

/**
 * Content-addressed in-memory cache of bundled tool artifacts.
 * Shared by one {@link DraftPackageCatalog} instance — i.e. one run.
 */
export class ToolBundleCache {
  private readonly cache = new Map<string, Uint8Array>();

  /**
   * Bundle a draft tool on first call, return the cached bytes on
   * subsequent calls with identical input.
   *
   * Throws {@link BundleError} with code `TOOL_BUNDLE_FAILED` on
   * bundler errors — propagated up to the run pipeline which fails
   * the run with the explicit message.
   */
  async bundle(input: BundleDraftToolInput): Promise<BundleDraftToolResult> {
    const { files, manifest, toolId } = input;
    const entrypoint = typeof manifest.entrypoint === "string" ? manifest.entrypoint : null;
    if (!entrypoint) {
      throw new BundleError(
        "TOOL_BUNDLE_FAILED",
        `Tool '${toolId}' manifest is missing 'entrypoint'`,
      );
    }

    const filesRecord = Object.fromEntries(files);
    const cacheKey = computeCacheKey(filesRecord, entrypoint);
    let compiled = this.cache.get(cacheKey);
    if (!compiled) {
      try {
        const result = await bundleTool({ files: filesRecord, entrypoint, toolId });
        compiled = result.compiled;
      } catch (err) {
        if (err instanceof ToolBundlerError) {
          throw new BundleError(
            "TOOL_BUNDLE_FAILED",
            `Tool '${toolId}' failed to bundle: ${err.message}`,
            { toolId, bundlerCode: err.code },
          );
        }
        throw err;
      }
      this.cache.set(cacheKey, compiled);
    }

    // Rebuild the file map: drop the source entrypoint, inject tool.js,
    // replace manifest.json with the rewritten one. Auxiliary files
    // (TOOL.md, assets) are preserved.
    const nextFiles = new Map<string, Uint8Array>();
    for (const [k, v] of files) {
      if (k === entrypoint || k === "manifest.json") continue;
      nextFiles.set(k, v);
    }
    nextFiles.set(PUBLISHED_TOOL_BUNDLE_FILENAME, compiled);

    const bundledManifest: Record<string, unknown> = {
      ...manifest,
      entrypoint: PUBLISHED_TOOL_BUNDLE_FILENAME,
    };
    nextFiles.set(
      "manifest.json",
      new TextEncoder().encode(JSON.stringify(bundledManifest, null, 2)),
    );

    return { files: nextFiles, manifest: bundledManifest };
  }
}

/** Content-addressed hash of (entrypoint, sorted file entries). */
function computeCacheKey(files: Record<string, Uint8Array>, entrypoint: string): string {
  const hash = createHash("sha256");
  hash.update(entrypoint);
  hash.update("\0");
  for (const k of Object.keys(files).sort()) {
    hash.update(k);
    hash.update("\0");
    const bytes = files[k];
    if (bytes) hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}
