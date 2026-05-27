// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure manifest rewrite logic for the mcp-server bundler.
 *
 * The author-time MCPB manifest may carry an author-sugar vendoring source
 * under `_meta["dev.appstrate/vendor"]` (npm/pypi). After vendoring, the
 * distributed manifest MUST be runnable as-is — no further resolution at
 * spawn time. This module is the bridge: it takes the source manifest + a
 * `VendorResult` and returns the distributed manifest with `server.type`
 * rewritten to a concrete runtime, `server.entry_point` pinned to the
 * vendored file, the `_meta["dev.appstrate/vendor"]` intent stripped, and
 * `_meta["dev.appstrate/source-resolution"]` capturing what was resolved.
 *
 * Kept side-effect-free so we can unit-test rewrite behavior without
 * touching the network or the disk.
 */

import type { McpServerManifest } from "../mcp-server.ts";
import {
  SOURCE_RESOLUTION_META_KEY,
  VENDOR_META_KEY,
  type BunCompatProbeResult,
  type VendorResult,
} from "./types.ts";

const BUN_COMPAT_META_KEY = "dev.appstrate/bun-compat";

export function rewriteManifestForDistribution(
  source: McpServerManifest,
  vendor: VendorResult,
  bunCompat?: BunCompatProbeResult,
): McpServerManifest {
  const sourceServer = (source as { server?: Record<string, unknown> }).server ?? {};
  // The distributed manifest carries a concrete runtime type + the vendored
  // entry point. `mcp_config.command`/`args` are rewritten to invoke the
  // vendored entry under the resolved interpreter so the bundle is runnable
  // as-is.
  const command = vendor.rewrittenServerType === "node" ? "node" : vendor.rewrittenEntryPoint;
  const args = vendor.rewrittenServerType === "node" ? [vendor.rewrittenEntryPoint] : [];
  const rewrittenServer: Record<string, unknown> = {
    ...sourceServer,
    type: vendor.rewrittenServerType,
    entry_point: vendor.rewrittenEntryPoint,
    mcp_config: { ...(sourceServer.mcp_config as Record<string, unknown>), command, args },
  };

  const prevMeta = ((source as { _meta?: Record<string, unknown> })._meta ?? {}) as Record<
    string,
    unknown
  >;
  const nextMeta: Record<string, unknown> = { ...prevMeta };
  // Strip the author-only vendoring intent from the distributed manifest.
  delete nextMeta[VENDOR_META_KEY];
  nextMeta[SOURCE_RESOLUTION_META_KEY] = vendor.resolution;
  if (bunCompat) {
    nextMeta[BUN_COMPAT_META_KEY] = {
      ok: bunCompat.ok,
      ...(bunCompat.ok ? {} : bunCompat.reason ? { reason: bunCompat.reason } : {}),
    };
  }

  return {
    ...source,
    server: rewrittenServer,
    _meta: nextMeta,
  } as unknown as McpServerManifest;
}

/**
 * Tiny helper used by the CLI to compute the canonical output file
 * name for an mcp-server bundle. AFPS lifted the scoped identity
 * `name` to the manifest root (§3.4), so the top-level `name` IS the
 * AFPS scoped identity. Scoped names like `@official/gmail` become
 * `official__gmail@1.0.0.afps` (filesystem-safe).
 */
export function suggestBundleFileName(manifest: McpServerManifest): string {
  const afpsName = (manifest as { name: string }).name;
  const scoped = afpsName.startsWith("@") ? afpsName.slice(1) : afpsName;
  const safe = scoped.replace(/\//g, "__");
  return `${safe}@${(manifest as { version: string }).version}.afps`;
}
