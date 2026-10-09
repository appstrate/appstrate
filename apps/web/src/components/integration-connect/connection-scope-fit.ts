// SPDX-License-Identifier: Apache-2.0

import { expandScopesGranted, type IntegrationManifest } from "@appstrate/core/integration";

/**
 * How a connection's grant compares with what an agent needs:
 *  - `exact`   — covers the agent and grants nothing beyond it and the auth's `default_scopes`;
 *  - `broader` — covers the agent but grants more;
 *  - `missing` — lacks some of the agent's scopes (the server's `missing_scopes`).
 */
export type ScopeFit = "exact" | "broader" | "missing";

const FIT_RANK: Record<ScopeFit, number> = { exact: 0, broader: 1, missing: 2 };

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
 * A short line for a set of granted scopes: the first labels and `+N`, with every label in
 * `title`. The auth's `default_scopes` come last — every connection of that auth has them, so
 * they tell connections apart least.
 */
export function summarizeScopes(
  manifest: IntegrationManifest | undefined,
  authKey: string,
  scopes: readonly string[],
): { text: string; title: string } {
  const defaults = new Set(manifest?.auths?.[authKey]?.default_scopes ?? []);
  const ordered = [
    ...scopes.filter((s) => !defaults.has(s)),
    ...scopes.filter((s) => defaults.has(s)),
  ];
  const labels = scopeLabels(manifest, authKey, ordered);
  const more = labels.length - SUMMARY_MAX;
  const shown = labels.slice(0, SUMMARY_MAX).join(" · ");
  return { text: more > 0 ? `${shown} +${more}` : shown, title: labels.join(", ") };
}

/**
 * Where a connection stands for an agent. Coverage is the server's verdict (`missing`); breadth
 * compares the grant with `required ∪ default_scopes`, expanded through `scope_catalog[].implies`.
 */
export function scopeFit(input: {
  manifest: IntegrationManifest;
  authKey: string;
  granted: readonly string[];
  missing: readonly string[];
  required: readonly string[];
}): ScopeFit {
  if (input.missing.length > 0) return "missing";
  const defaults = input.manifest.auths?.[input.authKey]?.default_scopes ?? [];
  const allowed = new Set(
    expandScopesGranted([...input.required, ...defaults], input.manifest, input.authKey),
  );
  return input.granted.every((s) => allowed.has(s)) ? "exact" : "broader";
}

/** `items` ordered exact → broader → missing, keeping the given order within each. */
export function sortByScopeFit<T>(items: readonly T[], fitOf: (item: T) => ScopeFit): T[] {
  return [...items].sort((a, b) => FIT_RANK[fitOf(a)] - FIT_RANK[fitOf(b)]);
}
