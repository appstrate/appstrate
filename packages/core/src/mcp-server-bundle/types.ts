// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the mcp-server bundler.
 *
 * The bundler reads an author-time `mcp-server` (MCPB) manifest. The
 * runnable server config lives under `server.{type, entry_point, mcp_config}`
 * (AFPS §3.4). For author-sugar npm/pypi vendoring, the source is declared
 * under `_meta["dev.appstrate/vendor"] = { source: "npm" | "pypi",
 * identifier, version }` — MCPB has no native "fetch from registry" field, so
 * Appstrate carries the vendoring intent in its own `_meta` namespace and
 * strips it from the distributed manifest after vendoring. The bundler
 * produces a deterministic `.afps` archive where:
 *
 *   - Dependencies are vendored under `./server/`.
 *   - `server.type` is rewritten to `node` (npm) or `binary` (pypi).
 *   - `server.entry_point` points at the vendored executable.
 *   - `_meta["dev.appstrate/source-resolution"]` records the resolved version
 *     + integrity for audit.
 *
 * Network I/O and subprocess execution are abstracted as injectable
 * dependencies so the resolvers can be unit-tested without hitting npm,
 * pypi, or spawning real installers.
 */

import type { McpServerManifest } from "../mcp-server.ts";

/** The `_meta` key carrying author-sugar npm/pypi vendoring intent. */
export const VENDOR_META_KEY = "dev.appstrate/vendor";

/** The `_meta` key the bundler writes resolved-source provenance to. */
export const SOURCE_RESOLUTION_META_KEY = "dev.appstrate/source-resolution";

/**
 * Author-sugar vendoring source declared under
 * `_meta["dev.appstrate/vendor"]`. When present, the bundler resolves the
 * named registry package and vendors it into `./server/`.
 */
export interface VendorSource {
  source: "npm" | "pypi";
  /** Registry package identifier (e.g. `@modelcontextprotocol/server-filesystem`). */
  identifier: string;
  /** Semver range / exact version / dist-tag (e.g. `^1.0.0`, `1.4.2`, `latest`). */
  version: string;
  /** Override the registry base URL (defaults to npmjs.org / pypi.org). */
  registryBaseUrl?: string;
}

/**
 * Resolution metadata captured by the bundler and emitted into the
 * distributed manifest under `_meta["dev.appstrate/source-resolution"]`.
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
 * the rewritten MCPB server runtime type + entry_point, and resolution
 * metadata.
 */
export interface VendorResult {
  /**
   * File tree to merge into the bundle. Paths are POSIX-style and
   * relative to the bundle root (e.g. `"server/index.js"`).
   */
  files: Record<string, Uint8Array>;
  /** Distributed MCPB `server.type`. npm → `node`, pypi → `binary`. */
  rewrittenServerType: "node" | "binary";
  /** Distributed `server.entry_point` (relative to bundle root). */
  rewrittenEntryPoint: string;
  /** Provenance for `_meta["dev.appstrate/source-resolution"]`. */
  resolution: SourceResolution;
}

/**
 * Bun compatibility probe result. When `ok` is false, the bundler sets
 * `_meta["dev.appstrate/bun-compat"]: false` on the distributed manifest and
 * the caller decides whether to fall back to a Docker runner.
 */
export interface BunCompatProbeResult {
  ok: boolean;
  reason?: string;
  toolCount?: number;
  /**
   * Tool names returned by the probe's `tools/list` call, in server order.
   * Present only when the probe completed the handshake (`ok: true`).
   * Conformance tooling diffs these against the manifest's declared tools.
   */
  toolNames?: string[];
  durationMs?: number;
}

/**
 * Final outcome of `bundleMcpServer` — the produced ZIP bytes plus the
 * rewritten manifest for callers that want to inspect it without
 * re-parsing the archive (test assertions, CI logs).
 */
export interface BundleMcpServerResult {
  /** Deterministic ZIP bytes (suitable for writing to `<name>@<version>.afps`). */
  afps: Uint8Array;
  /** Final manifest as embedded in the bundle. */
  manifest: McpServerManifest;
  /** Suggested file name (`<scope>-<name>@<version>.afps`). */
  suggestedFileName: string;
  /** When the Bun probe ran, its outcome. */
  bunCompat?: BunCompatProbeResult;
}
