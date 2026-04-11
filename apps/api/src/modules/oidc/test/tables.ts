// SPDX-License-Identifier: Apache-2.0

/**
 * Tables owned by the OIDC module, listed FK-safe (children first).
 * The root test preload auto-discovers this file and registers these
 * tables with `truncateAll()` for per-test cleanup.
 */
export default [
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_consent",
  "oauth_client",
  "oidc_end_user_profiles",
  "jwks",
] as const;
