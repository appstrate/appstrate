// SPDX-License-Identifier: Apache-2.0

/**
 * Tables owned by the OIDC module, listed FK-safe (children first).
 * The root test preload auto-discovers this file and registers these
 * tables with `truncateAll()` for per-test cleanup.
 */
export default [
  "oauth_access_tokens",
  "oauth_refresh_tokens",
  "oauth_consents",
  "oauth_clients",
  "oidc_end_user_profiles",
  "application_smtp_configs",
  "application_social_providers",
  "jwks",
] as const;
