// SPDX-License-Identifier: Apache-2.0

/**
 * Tables owned by the OIDC module, listed FK-safe (children first).
 * The root test preload auto-discovers this file and registers these
 * tables with `truncateAll()` for per-test cleanup.
 */
export default [
  // `cli_refresh_tokens` has a self-FK on `parent_id`, so truncate before
  // `oauth_clients` (children reference clients) but there is no cross-table
  // dep on this row outside that one.
  "cli_refresh_tokens",
  "oauth_access_tokens",
  "oauth_refresh_tokens",
  "oauth_consents",
  "oauth_clients",
  "oidc_end_user_profiles",
  "application_smtp_configs",
  "application_social_providers",
  "jwks",
] as const;
