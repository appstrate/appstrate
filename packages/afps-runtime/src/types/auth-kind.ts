// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Authentication kinds a provider may declare in its manifest.
 *
 * A `CredentialProvider` declares which kinds it supports via
 * {@link CredentialProvider.supportedAuthKinds}. At boot time, the runtime
 * intersects the bundle's declared `auth_kinds` with the runner's
 * capabilities and fails closed on mismatch.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §11.
 */
export const AUTH_KINDS = [
  "api_key",
  "oauth2_client_creds",
  "oauth2_device_code",
  "oauth2_pkce_server",
  "pat",
] as const;

export type AuthKind = (typeof AUTH_KINDS)[number];
