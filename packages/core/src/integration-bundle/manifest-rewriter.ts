// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure manifest rewrite logic for the integration bundler.
 *
 * The author-time manifest may carry `server.type: "npx" | "uvx"` with
 * a `server.package` ref pointing at npm/pypi. After vendoring, the
 * distributed manifest MUST be runnable as-is — no further resolution
 * at spawn time (D31, proposal §4.1.7). This module is the bridge: it
 * takes the source manifest + a `VendorResult` and returns the
 * distributed manifest with `server.type` rewritten to a concrete
 * runtime, `entryPoint` pinned to the vendored file, and
 * `_meta.sourceResolution` capturing what was resolved.
 *
 * Kept side-effect-free so we can unit-test rewrite behavior without
 * touching the network or the disk.
 */

import type { IntegrationManifest } from "../integration.ts";
import type { BunCompatProbeResult, VendorResult } from "./types.ts";

export function rewriteManifestForDistribution(
  source: IntegrationManifest,
  vendor: VendorResult,
  bunCompat?: BunCompatProbeResult,
): IntegrationManifest {
  // Strip author-only `server.package` from the distributed manifest —
  // by Phase 1.2a, the runtime only needs `type` + `entryPoint`. The
  // resolution is preserved in `_meta.sourceResolution` for audit.
  const rewrittenServer = {
    ...source.server,
    type: vendor.rewrittenServerType,
    entryPoint: vendor.rewrittenEntryPoint,
    package: undefined,
    url: undefined,
  };
  // Drop undefined keys so consumers see a clean object.
  for (const k of ["package", "url"] as const) {
    if (rewrittenServer[k] === undefined) delete rewrittenServer[k];
  }

  const prevMeta = (source._meta ?? {}) as Record<string, unknown>;
  const nextMeta: Record<string, unknown> = { ...prevMeta };
  nextMeta.sourceResolution = vendor.resolution;
  if (bunCompat) {
    nextMeta.bunCompat = bunCompat.ok;
    if (!bunCompat.ok && bunCompat.reason) {
      nextMeta.bunCompatReason = bunCompat.reason;
    }
  }

  return {
    ...source,
    server: rewrittenServer,
    _meta: nextMeta,
  } as IntegrationManifest;
}

/**
 * Tiny helper used by the CLI to compute the canonical output file
 * name for an integration bundle. Scoped names like `@official/gmail`
 * become `official__gmail@1.0.0.afps` (filesystem-safe).
 */
export function suggestBundleFileName(manifest: IntegrationManifest): string {
  const scoped = manifest.name.startsWith("@") ? manifest.name.slice(1) : manifest.name;
  const safe = scoped.replace(/\//g, "__");
  return `${safe}@${manifest.version}.afps`;
}
