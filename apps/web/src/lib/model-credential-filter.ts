// SPDX-License-Identifier: Apache-2.0

/**
 * Which saved keys a form may bind to, for the provider it names.
 *
 * A provider whose endpoint the operator supplies has no endpoint to match on:
 * every one of its keys was saved against a host of its own, and the form reads
 * that host off the key it picks rather than asking for it to be retyped. A
 * provider that pins its own endpoint has the opposite problem — several of
 * them share one `apiShape` — so there the endpoint itself is the match.
 *
 * Built-in (`source: "built-in"`) credentials are never offered: they carry a
 * slug id (`"anthropic"`), and `org_models.credential_id` is a UUID FK, so the
 * insert would 400. Models against a system key are declared in the env
 * `models[]` block instead.
 */

/** The credential fields the rule reads — a `ModelProviderCredentialInfo` fits. */
interface CredentialCandidate {
  source: "built-in" | "custom";
  authMode: "api_key" | "oauth2";
  apiShape: string | null;
  baseUrl: string | null;
  providerId?: string | null;
}

/** The registry facts the rule turns on — a `ProviderRegistryEntry` fits. */
interface CredentialFilterProvider {
  providerId: string;
  authMode: "api_key" | "oauth2";
  baseUrlOverridable: boolean;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function selectableCredentials<T extends CredentialCandidate>(input: {
  credentials: readonly T[] | undefined;
  /** The picked registry entry; undefined until a provider is picked. */
  provider: CredentialFilterProvider | undefined;
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
