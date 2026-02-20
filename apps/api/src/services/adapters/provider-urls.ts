/**
 * Static provider → base URL and auth configuration.
 * Used by the /internal/credentials endpoint and prompt builder.
 */

export const PROVIDER_BASE_URLS: Record<string, string> = {
  gmail: "https://gmail.googleapis.com",
  "google-mail": "https://gmail.googleapis.com",
  "google-calendar": "https://www.googleapis.com",
  clickup: "https://api.clickup.com",
  brevo: "https://api.brevo.com",
  facebook: "https://graph.facebook.com",
};

export const PROVIDER_AUTH_CONFIG: Record<
  string,
  { authType: "bearer" | "api-key"; authHeader?: string }
> = {
  brevo: { authType: "api-key", authHeader: "api-key" },
};

/** Get auth config for a provider (defaults to bearer token). */
export function getProviderAuth(providerId: string): {
  authType: "bearer" | "api-key";
  authHeader: string;
} {
  const config = PROVIDER_AUTH_CONFIG[providerId];
  return {
    authType: config?.authType ?? "bearer",
    authHeader: config?.authHeader ?? "Authorization",
  };
}

/** URI matching: '*' at end = prefix match, otherwise exact match */
export function matchesAuthorizedUri(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return url.startsWith(pattern.slice(0, -1));
    }
    return url === pattern;
  });
}

/** Get default authorized_uris for a Nango provider (based on PROVIDER_BASE_URLS) */
export function getDefaultAuthorizedUris(serviceId: string, provider: string): string[] | null {
  const baseUrl = PROVIDER_BASE_URLS[serviceId] ?? PROVIDER_BASE_URLS[provider];
  return baseUrl ? [`${baseUrl}/*`] : null;
}

/** Get credential field name for a Nango service based on auth type */
export function getNangoCredentialField(serviceId: string): {
  name: string;
  description: string;
} {
  const config = PROVIDER_AUTH_CONFIG[serviceId];
  if (config?.authType === "api-key") {
    return { name: "api_key", description: "API key" };
  }
  return { name: "token", description: "OAuth access token" };
}
