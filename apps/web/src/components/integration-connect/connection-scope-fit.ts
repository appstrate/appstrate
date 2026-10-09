// SPDX-License-Identifier: Apache-2.0

import { expandScopesGranted, type IntegrationManifest } from "@appstrate/core/integration";

/**
 * How a connection's grant compares with what an agent needs:
 *  - `exact`    — covers the agent and grants no declared scope beyond it and `default_scopes`;
 *  - `unjudged` — covers the agent, breadth unknown: a non-oauth2 auth or one with no catalog;
 *  - `broader`  — covers the agent but grants more;
 *  - `missing`  — lacks some of the agent's scopes (the server's `missing_scopes`).
 */
export type ScopeFit = "exact" | "unjudged" | "broader" | "missing";

const FIT_RANK: Record<ScopeFit, number> = { exact: 0, unjudged: 1, broader: 2, missing: 3 };

/** How many labels a summary shows before folding the rest into `+N`. */
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
 * A short line for a granted set: what it grants beyond the auth's `default_scopes`, the first
 * labels and `+N`. Under a catalog, scopes it does not declare (an IdP's echo) are left out.
 * `text` is `null` when nothing is left — the caller names the defaults — and the whole set is
 * `null` for an empty grant. `title` labels every granted scope.
 */
export function summarizeScopes(
  manifest: IntegrationManifest | undefined,
  authKey: string,
  scopes: readonly string[],
): { text: string | null; title: string } | null {
  if (scopes.length === 0) return null;
  const auth = manifest?.auths?.[authKey];
  const defaults = new Set(auth?.default_scopes ?? []);
  const declared = auth?.scope_catalog?.length
    ? new Set(auth.scope_catalog.map((entry) => entry.value))
    : null;
  const telling = scopes.filter((s) => !defaults.has(s) && (declared?.has(s) ?? true));
  const labels = scopeLabels(manifest, authKey, telling);
  const more = labels.length - SUMMARY_MAX;
  const shown = labels.slice(0, SUMMARY_MAX).join(" · ");
  return {
    text: labels.length === 0 ? null : more > 0 ? `${shown} +${more}` : shown,
    title: scopeLabels(manifest, authKey, scopes).join(", "),
  };
}

/**
 * Where a connection stands for an agent. Coverage is the server's verdict (`missing`). Breadth
 * compares the granted scopes the auth's catalog declares with `required ∪ default_scopes`,
 * expanded through `scope_catalog[].implies`; an undeclared scope is the IdP's echo, not a grant.
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

/** `items` ordered exact → unjudged → broader → missing, keeping the given order within each. */
export function sortByScopeFit<T>(items: readonly T[], fitOf: (item: T) => ScopeFit): T[] {
  return [...items].sort((a, b) => FIT_RANK[fitOf(a)] - FIT_RANK[fitOf(b)]);
}
