// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the integration bundler (Phase 1.05, proposal §5.3).
 *
 * The bundler reads an author-time integration manifest (which may
 * declare `server.type: "npx" | "uvx"` with `server.package` carrying
 * a registry name + semver range) and produces a deterministic `.afps`
 * archive where:
 *
 *   - Dependencies are vendored under `./server/`.
 *   - `server.type` is rewritten to `node` / `uv` (D31).
 *   - `server.entryPoint` points at the vendored executable.
 *   - `_meta.sourceResolution` records the resolved version + integrity
 *     for audit (§4.1.7).
 *
 * Network I/O and subprocess execution are abstracted as injectable
 * dependencies so the resolvers can be unit-tested without hitting npm,
 * pypi, or spawning real installers.
 */

import type { IntegrationManifest } from "../integration.ts";

/**
 * Resolution metadata captured by the bundler and emitted into the
 * distributed manifest under `_meta.sourceResolution`. Mirrors the
 * shape documented in the proposal §4.1.7.
 */
export interface SourceResolution {
  registryType: "npm" | "pypi";
  identifier: string;
  versionRequested: string;
  versionResolved: string;
  integrity: string;
  resolvedAt: string;
}

/**
 * Outcome of a vendor pass: the file tree to embed under `./server/`,
 * the rewritten manifest server section, and the resolution metadata.
 */
export interface VendorResult {
  /**
   * File tree to merge into the bundle. Paths are POSIX-style and
   * relative to the bundle root (e.g. `"server/index.js"`,
   * `"server/node_modules/.../package.json"`).
   */
  files: Record<string, Uint8Array>;
  /** Distributed `server.type` (one of `node` / `uv` / `bun` / `python`). */
  rewrittenServerType: "node" | "uv";
  /** Distributed `server.entryPoint` (relative to bundle root). */
  rewrittenEntryPoint: string;
  /** Provenance for `_meta.sourceResolution`. */
  resolution: SourceResolution;
}

/**
 * Bun compatibility probe result (D31). When `ok` is false, the bundler
 * sets `_meta.bunCompat: false` on the distributed manifest and the
 * caller decides whether to fall back to `server.type: "docker"`.
 */
export interface BunCompatProbeResult {
  ok: boolean;
  reason?: string;
  toolCount?: number;
  durationMs?: number;
}

/**
 * Final outcome of `bundleIntegration` — the produced ZIP bytes plus
 * the rewritten manifest for callers that want to inspect it without
 * re-parsing the archive (test assertions, CI logs).
 */
export interface BundleIntegrationResult {
  /** Deterministic ZIP bytes (suitable for writing to `<name>@<version>.afps`). */
  afps: Uint8Array;
  /** Final manifest as embedded in the bundle. */
  manifest: IntegrationManifest;
  /** Suggested file name (`<scope>-<name>@<version>.afps`). */
  suggestedFileName: string;
  /** When the Bun probe ran, its outcome. */
  bunCompat?: BunCompatProbeResult;
}
