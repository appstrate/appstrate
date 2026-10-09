// SPDX-License-Identifier: Apache-2.0

import { expandScopesGranted, type IntegrationManifest } from "@appstrate/core/integration";

/** `unjudged`: covers the agent, but the auth (non-oauth2, or no catalog) gives no breadth. */
export type ScopeFit = "exact" | "unjudged" | "broader" | "missing";

const FIT_RANK: Record<ScopeFit, number> = { exact: 0, unjudged: 1, broader: 2, missing: 3 };

const SUMMARY_MAX = 2;

export interface ScopeSummary {
  /** What the grant adds to `default_scopes`, `+N`-folded; `null` when nothing. */
  text: string | null;
  /** The `default_scopes` the grant lacks; `null` when it holds them all. */
  lacking: string | null;
  title: string;
}

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

/** A grant told by what sets it apart; an IdP's echo the catalog does not declare is left out. */
export function summarizeScopes(
  manifest: IntegrationManifest | undefined,
  authKey: string,
  scopes: readonly string[],
): ScopeSummary | null {
  if (scopes.length === 0) return null;
  const auth = manifest?.auths?.[authKey];
  const defaults = auth?.default_scopes ?? [];
  const declared = auth?.scope_catalog?.length
    ? new Set(auth.scope_catalog.map((entry) => entry.value))
    : null;
  const telling = scopes.filter((s) => !defaults.includes(s) && (declared?.has(s) ?? true));
  const held = new Set(manifest ? expandScopesGranted(scopes, manifest, authKey) : scopes);
  const lacking = defaults.filter((s) => !held.has(s));
  const labels = scopeLabels(manifest, authKey, telling);
  const more = labels.length - SUMMARY_MAX;
  const shown = labels.slice(0, SUMMARY_MAX).join(" · ");
  return {
    text: labels.length === 0 ? null : more > 0 ? `${shown} +${more}` : shown,
    lacking: lacking.length === 0 ? null : scopeLabels(manifest, authKey, lacking).join(", "),
    title: scopeLabels(manifest, authKey, scopes).join(", "),
  };
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
