// SPDX-License-Identifier: Apache-2.0

/**
 * Which saved keys a form may bind to, for the provider it names.
 *
 * An overridable provider matches on `providerId` alone — each key was saved
 * against its own host, which the form reads off the key. A pinned provider
 * shares its `apiShape` with others, so there the endpoint is the match.
 * Built-in credentials are never offered: their slug id is no UUID FK.
 */

import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";

type CredentialCandidate = Pick<
  ModelProviderCredentialInfo,
  "source" | "authMode" | "apiShape" | "baseUrl" | "providerId"
>;

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function selectableCredentials<T extends CredentialCandidate>(input: {
  credentials: readonly T[] | undefined;
  provider:
    Pick<ProviderRegistryEntry, "providerId" | "authMode" | "baseUrlOverridable"> | undefined;
  /** The form's endpoint fields, read only where the provider pins its own. */
  apiShape: string;
  baseUrl: string;
}): T[] {
  const { credentials, provider, apiShape, baseUrl } = input;
  if (!credentials || !provider) return [];
  const custom = credentials.filter((k) => k.source === "custom");

  if (provider.authMode === "oauth2") {
    return custom.filter((k) => k.authMode === "oauth2" && k.providerId === provider.providerId);
  }
  if (provider.baseUrlOverridable) {
    return custom.filter((k) => k.authMode === "api_key" && k.providerId === provider.providerId);
  }
  if (!apiShape || !baseUrl) return [];
  const normalized = withoutTrailingSlash(baseUrl);
  return custom.filter(
    (k) =>
      k.authMode === "api_key" &&
      k.apiShape === apiShape &&
      k.baseUrl != null &&
      withoutTrailingSlash(k.baseUrl) === normalized,
  );
}
