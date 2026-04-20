// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { AuthKind } from "../types/auth-kind.ts";

/**
 * Source of credentials for a running agent. The runtime never holds
 * credentials directly; it delegates to whichever provider the runner
 * has wired. Same contract whether running inside Appstrate (where
 * credentials come from the platform DB via the sidecar proxy) or on a
 * developer's laptop (where credentials come from a local JSON file).
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §6, §11.
 *
 * Bundled implementations:
 *
 * - `AppstrateCredentialProvider` — HTTP to the Appstrate credential
 *   bridge (wraps the existing sidecar `/proxy` flow)
 * - `FileCredentialProvider` — local JSON file
 * - `EnvCredentialProvider` — environment variables by convention
 *   (`AFPS_CRED_{providerId}_{field}`)
 * - `VaultCredentialProvider` — 1Password / Doppler / HashiCorp Vault
 *
 * Implementations MUST honour the `authorizedUris` allowlist returned
 * with the credentials — the runtime uses it to gate outbound traffic
 * at the proxy layer. Implementations MUST NOT return credentials as
 * plaintext in log output.
 */
export interface CredentialProvider {
  /**
   * Fetch credentials for a specific provider. The returned
   * `authorizedUris` list scopes where the credentials are allowed to
   * be used — requests to URIs outside this list MUST be rejected
   * upstream.
   *
   * `expiresAt` (Unix ms) is advisory for rotation scheduling. The
   * runtime will call {@link refresh} when the value is within a
   * provider-specific margin of the current time.
   */
  getCredentials(providerId: string): Promise<CredentialsResponse>;

  /**
   * Optional: trigger a credential refresh out-of-band (for OAuth2
   * refresh tokens, for example). Idempotent — calling `refresh`
   * concurrently for the same provider MUST be safe.
   */
  refresh?(providerId: string): Promise<void>;

  /**
   * Declarative capability. Combined with the bundle's
   * `providers[].auth_kinds`, the runtime refuses to start if the
   * bundle requires an authentication kind the provider cannot
   * satisfy (fail-closed).
   */
  supportedAuthKinds(): AuthKind[];
}

export interface CredentialsResponse {
  credentials: Record<string, string>;
  authorizedUris: string[];
  expiresAt?: number;
}
