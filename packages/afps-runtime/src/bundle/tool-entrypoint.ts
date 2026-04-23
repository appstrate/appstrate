// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS §3.4 — resolve a tool package's loadable entrypoint.
 *
 * Every AFPS tool loader (the generic {@link BundledToolResolver} exported
 * from `@appstrate/afps-runtime/resolvers`, the Appstrate-specific Pi loader
 * in `@appstrate/runner-pi`) has to do the same three checks before it can
 * touch the bytes:
 *
 *   1. `manifest.entrypoint` is a non-empty string.
 *   2. The path is safe (no absolute path, no `..` traversal).
 *   3. The file actually exists inside the archive.
 *
 * This helper centralises those checks so the §3.4 contract has one
 * implementation. Callers wrap the thrown {@link AfpsEntrypointError}
 * into whatever error class their API surface exposes.
 */

import type { BundlePackage } from "./types.ts";

export type AfpsEntrypointErrorCode = "MISSING" | "UNSAFE_PATH" | "FILE_ABSENT";

export class AfpsEntrypointError extends Error {
  constructor(
    public readonly code: AfpsEntrypointErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AfpsEntrypointError";
  }
}

export interface ResolvedToolEntrypoint {
  /** The archive-relative path declared by `manifest.entrypoint`. */
  readonly entrypoint: string;
  /** The bytes of that file, as stored in the archive. */
  readonly bytes: Uint8Array;
}

/**
 * Validate and read the tool entrypoint from a {@link BundlePackage}.
 *
 * Throws {@link AfpsEntrypointError} with a machine-readable `code`:
 * - `MISSING` — `manifest.entrypoint` is absent or not a string.
 * - `UNSAFE_PATH` — the path starts with `/` or contains `..`.
 * - `FILE_ABSENT` — the declared file is not present in the archive.
 *
 * @param pkg - The tool package from a resolved AFPS bundle.
 * @param label - Human-readable identifier used in error messages
 *   (e.g. the dependency ref name, or the runner's internal tool id).
 *   Defaults to the package's identity string.
 */
export function resolveToolEntrypoint(pkg: BundlePackage, label?: string): ResolvedToolEntrypoint {
  const who = label ?? pkg.identity;
  const manifest = pkg.manifest as { entrypoint?: unknown };
  const entrypoint = typeof manifest.entrypoint === "string" ? manifest.entrypoint : null;
  if (!entrypoint) {
    throw new AfpsEntrypointError(
      "MISSING",
      `Tool '${who}' has no manifest.entrypoint (AFPS §3.4)`,
    );
  }
  if (entrypoint.startsWith("/") || entrypoint.includes("..")) {
    throw new AfpsEntrypointError(
      "UNSAFE_PATH",
      `Tool '${who}' has an unsafe manifest.entrypoint path: '${entrypoint}'`,
    );
  }
  const bytes = pkg.files.get(entrypoint);
  if (!bytes) {
    throw new AfpsEntrypointError(
      "FILE_ABSENT",
      `Tool '${who}' declares manifest.entrypoint='${entrypoint}' but the archive has no such file`,
    );
  }
  return { entrypoint, bytes };
}
