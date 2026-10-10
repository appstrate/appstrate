// SPDX-License-Identifier: Apache-2.0

import { META_NAMESPACE_KEY_REGEX } from "@appstrate/core/validation";
import { findRetiredDependencyKeys } from "@appstrate/core/dependencies";
import { normalizeMime } from "@appstrate/core/mime";
import { headerNamed } from "@appstrate/afps-runtime/resolvers";

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

interface LoginShape {
  request?: { headers?: Record<string, string>; content_type?: string };
  success_criteria?: unknown[];
}

/**
 * Warn on a `connect.login` that posts a form and declares no `success_criteria`. Any 2xx then
 * counts as success, and a web app commonly answers a wrong password with `200` and its login
 * page: the connection would be stored with a dead session. Pure; `[]` for any other manifest.
 */
export function collectLoginCriteriaWarnings(manifest: unknown): string[] {
  const auths = (manifest as { auths?: unknown } | null)?.auths;
  if (typeof auths !== "object" || auths === null) return [];
  const warnings: string[] = [];
  for (const [key, auth] of Object.entries(auths)) {
    const login = (auth as { connect?: { login?: LoginShape } } | null)?.connect?.login;
    if (!login?.request || (login.success_criteria?.length ?? 0) > 0) continue;
    const header = headerNamed(login.request.headers ?? {}, "content-type");
    if (
      normalizeMime(header ?? login.request.content_type) !== "application/x-www-form-urlencoded"
    ) {
      continue;
    }
    warnings.push(
      `auths.${key}.connect.login: a form login with no success_criteria counts any 2xx as success — declare what only a logged-in answer has (a cookie, a redirect target, a body marker), or a refused login is stored as a connection`,
    );
  }
  return warnings;
}
