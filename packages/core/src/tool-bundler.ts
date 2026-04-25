// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Tool pre-bundling (AFPS §3.4 — "Published archives").
 *
 * Takes a tool package's raw file map + draft `manifest.entrypoint` and
 * produces a self-contained ESM artifact every AFPS runner can load
 * without resolving the source's bare-specifier imports against an
 * ambient module graph. Callers are expected to rewrite the published
 * archive's `manifest.entrypoint` to point at the emitted bytes.
 *
 * Externals contract:
 *   - Pi SDK packages stay external — the runner controls them.
 *   - `node:*` built-ins stay external — the host provides them
 *     (kept external automatically by `target: "bun"`).
 *   - Everything else inlines.
 *
 * Bundler choice: Bun.build (native to the stack, ESM-first, TS-native,
 * zero additional binary to manage).
 *
 * Resolution model: writes the tool's files to an `os.tmpdir()` scratch
 * dir and invokes `Bun.build` with the absolute entrypoint path. Bun
 * walks up from there looking for `node_modules/`; the process running
 * this helper (apps/api, registry, or CLI) must itself sit inside a
 * tree that already has every runtime dep the tool imports. That's
 * guaranteed for all three callers — they run from the same monorepo
 * where the tool was authored.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { zipArtifact } from "./zip.ts";

/**
 * Packages the Pi SDK runtime contract keeps external. Anything else
 * inlines into the bundled artifact so the final tool.js is portable
 * across every runner (Docker container, CLI, custom runners).
 */
export const PI_SDK_EXTERNALS: readonly string[] = Object.freeze([
  "@mariozechner/pi-ai",
  "@mariozechner/pi-coding-agent",
]);

/**
 * Hard cap on a single tool's bundled artifact. A normal tool lands
 * at a few KiB; anything over this cap usually means `lodash`, a
 * Markdown renderer, or another heavy dep accidentally pulled in.
 */
export const TOOL_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;

export type ToolBundlerErrorCode =
  | "INVALID_ENTRYPOINT"
  | "BUNDLE_FAILED"
  | "BUNDLE_EMPTY"
  | "BUNDLE_TOO_LARGE";

/** Error thrown by {@link bundleTool} with a machine-readable code. */
export class ToolBundlerError extends Error {
  constructor(
    public readonly code: ToolBundlerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolBundlerError";
  }
}

export interface BundleToolInput {
  /**
   * Archive-relative file map (the shape `parsePackageZip(...).files`
   * returns). The bundler materialises every entry to disk so
   * multi-file tools (shared helpers, fixtures) resolve correctly.
   */
  files: Record<string, Uint8Array>;
  /** `manifest.entrypoint` — archive-relative path to the tool source. */
  entrypoint: string;
  /** Package identifier (e.g. `@scope/tool`). Used in error messages only. */
  toolId: string;
}

export interface BundleToolResult {
  /** Self-contained ESM artifact ready to be written as `tool.js`. */
  compiled: Uint8Array;
}

/**
 * Bundle a tool package's source into a self-contained ESM artifact.
 *
 * Idempotent on input: same `files` + `entrypoint` + bundler version
 * yield byte-identical `compiled` output, so the caller's integrity
 * hash is stable for a given package revision.
 */
export async function bundleTool(input: BundleToolInput): Promise<BundleToolResult> {
  const { files, entrypoint, toolId } = input;

  if (!entrypoint || entrypoint.startsWith("/") || entrypoint.includes("..")) {
    throw new ToolBundlerError(
      "INVALID_ENTRYPOINT",
      `Tool '${toolId}' has invalid manifest.entrypoint: '${entrypoint}'`,
    );
  }
  if (!(entrypoint in files)) {
    throw new ToolBundlerError(
      "INVALID_ENTRYPOINT",
      `Tool '${toolId}' declares entrypoint '${entrypoint}' but the archive has no such file`,
    );
  }

  // Scratch dir must sit below a `node_modules/` tree — Bun.build
  // resolves bare-specifier imports by walking up from the entrypoint
  // file and `os.tmpdir()` is outside the monorepo. We plant the
  // scratch inside the caller's own `node_modules/.cache/` so
  // `ajv`, `zod`, etc. resolve against the caller's dep graph.
  const nodeModulesRoot = await findNodeModulesRoot();
  const scratchBase = nodeModulesRoot
    ? path.join(nodeModulesRoot, ".cache", "afps-bundler")
    : os.tmpdir();
  await fs.mkdir(scratchBase, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(scratchBase, "afps-bundle-"));
  const workDirWithSep = workDir.endsWith(path.sep) ? workDir : workDir + path.sep;

  try {
    for (const [rel, bytes] of Object.entries(files)) {
      if (!rel || rel.endsWith("/")) continue;
      const dest = path.join(workDir, rel);
      // Defense-in-depth: reject any entry that escapes the scratch dir
      // (parsePackageZip already sanitises on ingress, but this helper
      // also gets called from other code paths).
      if (!dest.startsWith(workDirWithSep)) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, bytes);
    }

    const entrypointPath = path.join(workDir, entrypoint);

    let output: Awaited<ReturnType<typeof Bun.build>>;
    try {
      output = await Bun.build({
        entrypoints: [entrypointPath],
        target: "bun",
        format: "esm",
        sourcemap: "none",
        minify: false,
        external: [...PI_SDK_EXTERNALS],
      });
    } catch (err) {
      throw new ToolBundlerError(
        "BUNDLE_FAILED",
        `Tool '${toolId}' bundler crashed: ${formatBundlerError(err)}`,
      );
    }

    if (!output.success) {
      const logs = formatBuildLogs(output.logs);
      throw new ToolBundlerError(
        "BUNDLE_FAILED",
        `Tool '${toolId}' failed to bundle:\n${logs || "(no bundler logs)"}`,
      );
    }

    const entry = output.outputs.find((o) => o.kind === "entry-point") ?? output.outputs[0];
    if (!entry) {
      throw new ToolBundlerError("BUNDLE_EMPTY", `Tool '${toolId}' produced no output files`);
    }

    const bytes = stripNonDeterministicPreamble(new Uint8Array(await entry.arrayBuffer()));
    if (bytes.byteLength > TOOL_BUNDLE_MAX_BYTES) {
      throw new ToolBundlerError(
        "BUNDLE_TOO_LARGE",
        `Tool '${toolId}' bundled to ${bytes.byteLength} bytes (limit ${TOOL_BUNDLE_MAX_BYTES})`,
      );
    }

    return { compiled: bytes };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** Name of the emitted bundle inside a published tool archive (AFPS §3.4). */
export const PUBLISHED_TOOL_BUNDLE_FILENAME = "tool.js";

export interface BuildPublishedToolArchiveInput {
  /** Draft archive files, keyed by archive-relative path (same shape as `parsePackageZip(...).files`). */
  files: Record<string, Uint8Array>;
  /** Draft manifest. Must declare `entrypoint` pointing to the source. Read but not mutated. */
  manifest: Record<string, unknown>;
  /** Package identifier (e.g. `@scope/tool`). Used in error messages. */
  toolId: string;
}

export interface BuildPublishedToolArchiveResult {
  /** ZIP bytes, ready for storage. */
  archive: Uint8Array;
  /** The final manifest stored inside the archive, with `entrypoint` rewritten to `tool.js`. */
  manifest: Record<string, unknown>;
}

/**
 * Turn a draft tool package into a publishable AFPS archive (§3.4).
 *
 * Pipeline:
 *   1. Read `manifest.entrypoint` (draft points at source).
 *   2. Invoke {@link bundleTool} to produce a self-contained artifact.
 *   3. Inject it as `tool.js`, rewrite `manifest.entrypoint` to `tool.js`.
 *   4. Re-serialise `manifest.json` and zip everything.
 *
 * Callers keep ownership of error-wrapping policy: {@link ToolBundlerError}
 * (code `INVALID_ENTRYPOINT` when the draft has no entrypoint, or the codes
 * raised by `bundleTool` itself) propagates up, and callers can catch it
 * to translate into their own API error type.
 */
export async function buildPublishedToolArchive(
  input: BuildPublishedToolArchiveInput,
): Promise<BuildPublishedToolArchiveResult> {
  const { files, manifest, toolId } = input;
  const draftEntrypoint = typeof manifest.entrypoint === "string" ? manifest.entrypoint : null;
  if (!draftEntrypoint) {
    throw new ToolBundlerError(
      "INVALID_ENTRYPOINT",
      `Tool '${toolId}' manifest is missing 'entrypoint'`,
    );
  }
  const { compiled } = await bundleTool({ files, entrypoint: draftEntrypoint, toolId });
  const publishedManifest: Record<string, unknown> = {
    ...manifest,
    entrypoint: PUBLISHED_TOOL_BUNDLE_FILENAME,
  };
  const entries: Record<string, Uint8Array> = {
    ...files,
    [PUBLISHED_TOOL_BUNDLE_FILENAME]: compiled,
    "manifest.json": new TextEncoder().encode(JSON.stringify(publishedManifest, null, 2)),
  };
  return { archive: zipArtifact(entries, 6), manifest: publishedManifest };
}

/**
 * Walk up from this module's directory looking for the nearest
 * `node_modules/` folder. Returns its absolute path or null when the
 * helper is being executed from a tree that has none (should never
 * happen in practice but we keep the caller sane).
 */
async function findNodeModulesRoot(): Promise<string | null> {
  let dir = import.meta.dir;
  for (;;) {
    const candidate = path.join(dir, "node_modules");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      /* continue walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Extract human-readable detail from whatever Bun.build surfaces when
 * it rejects. It can be: a single Error (syntax), an AggregateError
 * (multi-file failures), or a BuildMessage-like with `.position`.
 */
function formatBundlerError(err: unknown): string {
  if (err instanceof AggregateError) {
    return err.errors.map((e) => formatBundlerError(e)).join("\n");
  }
  if (err instanceof Error) {
    return err.message || err.name || String(err);
  }
  return String(err);
}

/**
 * Bun.build's `logs` array holds `BuildMessage` objects with level
 * (error/warn/debug/info), message, position, and notes. Flatten them
 * into readable multi-line text — the default `String(logMessage)`
 * drops most context.
 */
function formatBuildLogs(logs: ReadonlyArray<unknown>): string {
  return logs
    .map((log) => {
      if (typeof log === "string") return log;
      if (log instanceof Error) return log.message;
      const obj = log as {
        level?: string;
        message?: string;
        position?: { file?: string; line?: number; column?: number };
      };
      const prefix = obj.level ? `[${obj.level}]` : "";
      const loc = obj.position
        ? ` at ${obj.position.file}:${obj.position.line}:${obj.position.column}`
        : "";
      const msg = obj.message ?? String(log);
      return `${prefix} ${msg}${loc}`.trim();
    })
    .join("\n");
}

/**
 * Bun prefixes every build output with a `// @bun` marker followed by
 * a comment naming the absolute entrypoint path — useful for debugging
 * but devastating for determinism since we run the bundler in a
 * `os.tmpdir()` scratch dir whose name changes every invocation.
 *
 * Strip the path line so two `bundleTool()` calls with identical input
 * produce byte-identical output (integrity hashing relies on it). The
 * `// @bun` marker itself is stable and kept as a format hint.
 */
function stripNonDeterministicPreamble(bytes: Uint8Array): Uint8Array {
  const decoded = new TextDecoder().decode(bytes);
  const cleaned = decoded.replace(/^(\/\/ @bun\n)\/\/ [^\n]*\n/, "$1");
  return cleaned === decoded ? bytes : new TextEncoder().encode(cleaned);
}
