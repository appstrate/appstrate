// SPDX-License-Identifier: Apache-2.0

export type ReauthMethod = { kind: "social"; provider: "google" | "github" } | { kind: "password" };

/**
 * Which re-authentication methods to offer for a step-up re-login. Password
 * (`credential`) comes first: no redirect, retry inline. Social needs the provider
 * linked AND its feature flag on. No accounts → `[]` (the modal shows its generic fallback).
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
