// SPDX-License-Identifier: Apache-2.0

import { expandScopesGranted, type IntegrationManifest } from "@appstrate/core/integration";

/** `unjudged`: covers the agent, but the auth (non-oauth2, or no catalog) gives no breadth. */
export type ScopeFit = "exact" | "unjudged" | "broader" | "missing";

const FIT_RANK: Record<ScopeFit, number> = { exact: 0, unjudged: 1, broader: 2, missing: 3 };

const SUMMARY_MAX = 2;

/** The manifest's `scope_catalog` label of each scope, the raw scope when it declares none. */
export function scopeLabels(
  manifest: IntegrationManifest | undefined,
  authKey: string,
  scopes: readonly string[],
): string[] {
  const catalog = manifest?.auths?.[authKey]?.scope_catalog ?? [];
  const labelOf = new Map(catalog.map((entry) => [entry.value, entry.label]));
  return scopes.map((s) => labelOf.get(s) ?? s);
}

/**
 * A non-empty grant in one line, non-default scopes first, `+N`-folded; `null` when it is the
 * defaults exactly. An IdP echo the catalog does not declare is left out, and a default the IdP
 * did not echo is never reported missing.
 */
export function summarizeScopes(
  manifest: IntegrationManifest | undefined,
  authKey: string,
  scopes: readonly string[],
): string | null {
  const auth = manifest?.auths?.[authKey];
  const defaults = auth?.default_scopes ?? [];
  const catalog = auth?.scope_catalog ?? [];
  const declared = catalog.length
    ? scopes.filter((s) => catalog.some((entry) => entry.value === s))
    : scopes;
  const extra = declared.filter((s) => !defaults.includes(s));
  const held = new Set(manifest ? expandScopesGranted(scopes, manifest, authKey) : scopes);
  if (extra.length === 0 && defaults.every((s) => held.has(s))) return null;
  const ordered = [...extra, ...declared.filter((s) => defaults.includes(s))];
  const labels = scopeLabels(manifest, authKey, ordered.length > 0 ? ordered : scopes);
  const shown = labels.slice(0, SUMMARY_MAX).join(" · ");
  return labels.length > SUMMARY_MAX ? `${shown} +${labels.length - SUMMARY_MAX}` : shown;
}

/**
 * Coverage is the server's verdict (`missing`). Breadth compares the granted scopes the catalog
 * declares with `required ∪ default_scopes`, expanded through `implies`.
 */
export function scopeFit(input: {
  manifest: IntegrationManifest;
  authKey: string;
  granted: readonly string[];
  missing: readonly string[];
  required: readonly string[];
}): ScopeFit {
  if (input.missing.length > 0) return "missing";
  const auth = input.manifest.auths?.[input.authKey];
  if (auth?.type !== "oauth2" || !auth.scope_catalog?.length) return "unjudged";
  const declared = new Set(auth.scope_catalog.map((entry) => entry.value));
  const allowed = new Set(
    expandScopesGranted(
      [...input.required, ...(auth.default_scopes ?? [])],
      input.manifest,
      input.authKey,
    ),
  );
  return input.granted.some((s) => declared.has(s) && !allowed.has(s)) ? "broader" : "exact";
}

/** Stable: exact → unjudged → broader → missing. */
export function sortByScopeFit<T>(items: readonly T[], fitOf: (item: T) => ScopeFit): T[] {
  return [...items].sort((a, b) => FIT_RANK[fitOf(a)] - FIT_RANK[fitOf(b)]);
}
