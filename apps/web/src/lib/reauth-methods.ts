// SPDX-License-Identifier: Apache-2.0

export type ReauthMethod = { kind: "social"; provider: "google" | "github" } | { kind: "password" };

/**
 * Decide which re-authentication methods to offer for a step-up re-login,
 * given the accounts linked to the user and which social providers the
 * instance has enabled.
 *
 * - `credential` linked → password (always offered first: no redirect, retry
 *   can happen inline).
 * - `google`/`github` linked **and** the matching feature flag on → social.
 * - `undefined`/empty accounts → `[]` (defensive; the modal then shows the
 *   generic "log back in" fallback).
 * - unknown providers are ignored.
 */
export function availableReauthMethods(
  accounts: Array<{ providerId: string }> | undefined,
  features: { googleAuth: boolean; githubAuth: boolean },
): ReauthMethod[] {
  if (!accounts || accounts.length === 0) return [];

  const linked = new Set(accounts.map((a) => a.providerId));
  const methods: ReauthMethod[] = [];

  if (linked.has("credential")) {
    methods.push({ kind: "password" });
  }
  if (linked.has("google") && features.googleAuth) {
    methods.push({ kind: "social", provider: "google" });
  }
  if (linked.has("github") && features.githubAuth) {
    methods.push({ kind: "social", provider: "github" });
  }

  return methods;
}
