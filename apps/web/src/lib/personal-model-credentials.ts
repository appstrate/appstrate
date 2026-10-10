// SPDX-License-Identifier: Apache-2.0

/**
 * Providers a member may own a credential for: subscriptions, and key-based
 * providers at their fixed endpoint. A custom endpoint is organization-only.
 */
export function personalCredentialProviders<
  T extends { authMode: "api_key" | "oauth2"; baseUrlOverridable: boolean },
>(registry: readonly T[]): T[] {
  return registry.filter(
    (p) => p.authMode === "oauth2" || (p.authMode === "api_key" && !p.baseUrlOverridable),
  );
}

/** The caller's own personal credentials, out of an org-wide list (a reader gets every member's). */
export function ownPersonalCredentials<
  T extends { owner_type: "org" | "user"; owner_id: string | null },
>(credentials: readonly T[], userId: string | undefined): T[] {
  if (!userId) return [];
  return credentials.filter((c) => c.owner_type === "user" && c.owner_id === userId);
}

/** The organization models the caller's own credentials pay for (`billed_to` is computed for the caller). */
export function modelsPaidByCaller<T extends { billed_to: "user" | "org" | null }>(
  models: readonly T[],
): T[] {
  return models.filter((m) => m.billed_to === "user");
}

/** Body of a personal API-key credential: owned by the caller, so the server refuses a custom endpoint. */
export function personalApiKeyBody(input: { providerId: string; label: string; apiKey: string }) {
  return {
    providerId: input.providerId,
    label: input.label,
    api_key: input.apiKey,
    owner_type: "user" as const,
  };
}
