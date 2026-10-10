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

/** Body of a personal API-key credential: owned by the caller, so the server refuses a custom endpoint. */
export function personalApiKeyBody(input: { providerId: string; label: string; apiKey: string }) {
  return {
    providerId: input.providerId,
    label: input.label,
    api_key: input.apiKey,
    owner_type: "user" as const,
  };
}

/**
 * Body of a credential's PATCH: its label, and the key only for a key-based
 * credential. A subscription has no key to send, so an entered one is ignored.
 */
export function credentialUpdateBody(
  credential: { readonly authMode: string },
  data: { label: string; apiKey?: string },
) {
  return {
    label: data.label,
    ...(data.apiKey && credential.authMode !== "oauth2" ? { api_key: data.apiKey } : {}),
  };
}
