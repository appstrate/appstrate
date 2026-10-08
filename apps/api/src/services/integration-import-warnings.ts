// SPDX-License-Identifier: Apache-2.0

import { META_NAMESPACE_KEY_REGEX } from "@appstrate/core/validation";
import { findRetiredDependencyKeys } from "@appstrate/core/dependencies";

/**
 * Collect import-time warnings for AFPS 1.x `dependencies` keys AFPS 2.0
 * retired (`tools` → `mcp_servers`, `providers` → `integrations`).
 *
 * Author input carrying one is REJECTED upstream by `validateManifest` — this
 * channel exists for the other direction: a manifest the platform already holds
 * (a published, integrity-checked artifact re-ingested through a bundle) cannot
 * be repaired in place, so it is validated with `retiredRuntimeTools: "drop"`
 * and keeps its retired key. The key is inert (no reader has ever read it), so
 * nothing is stripped and nothing breaks — but the operator should learn that
 * the dependencies declared under it were never honoured, and that a republish
 * is the fix.
 *
 * Applies to ALL package types — every type's manifest may declare
 * `dependencies`. Pure function; returns `[]` for a clean manifest.
 */
export function collectRetiredDependencyKeyWarnings(manifest: unknown): string[] {
  return findRetiredDependencyKeys(manifest).map(
    ({ key, replacement }) =>
      `dependencies.${key} is a retired AFPS 1.x key (renamed to dependencies.${replacement}) and is ignored — republish to remove it`,
  );
}

/**
 * Walk a package manifest's top-level `_meta` block and collect import-time
 * warnings for namespace keys that don't match the AFPS Appendix B
 * `META_NAMESPACE_KEY` regex — surface the
 * soft-fail warnings the core validator emits to `console.warn` only.
 *
 * Reserved-prefix keys (`mcp/`, `modelcontextprotocol/`) are hard-rejected
 * upstream by the validator (§10), so they cannot reach this code path.
 * Applies to ALL package types — every type's manifest can carry `_meta`.
 *
 * Pure function. Returns `[]` when `_meta` is absent or well-formed.
 */
export function collectMetaWarnings(manifest: unknown): string[] {
  const warnings: string[] = [];
  if (typeof manifest !== "object" || manifest === null) return warnings;
  const meta = (manifest as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return warnings;

  for (const key of Object.keys(meta as Record<string, unknown>)) {
    if (!META_NAMESPACE_KEY_REGEX.test(key)) {
      warnings.push(
        `_meta.${key}: key "${key}" does not match the AFPS Appendix B META_NAMESPACE_KEY pattern — accepted for forward compatibility per §10.1, but consumers may not recognise it.`,
      );
    }
  }

  return warnings;
}
