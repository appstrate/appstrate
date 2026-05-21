// SPDX-License-Identifier: Apache-2.0

/** Actor identity — dashboard user or end-user (headless). Re-exported from `@appstrate/core/platform-types` to keep one canonical definition. */
export type { Actor } from "@appstrate/core/platform-types";

export interface OAuthStateRecord {
  state: string;
  orgId: string;
  userId: string | null;
  endUserId?: string | null;
  applicationId: string;
  providerId: string;
  codeVerifier: string;
  scopesRequested: string[];
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
  authMode: string;
  oauthTokenSecret?: string;
  /**
   * Phase 1.3 — when the state was issued from an integration auth
   * (`POST /api/integrations/:pkgId/auths/:authKey/connect/oauth2`), the
   * callback dispatcher uses this discriminator to route the exchange to
   * the integration handler rather than the legacy provider handler.
   * `providerId` carries a sentinel string in that case but the real
   * truth lives here.
   */
  integration?: {
    packageId: string;
    authKey: string;
    /** Explicit token URL — Mode A endpoints come from the manifest. */
    tokenUrl: string;
    /** Optional RFC 8707 `resource` parameter for the token exchange. */
    audience?: string;
    /** OAuth2 token endpoint client auth method declared on the auth. */
    tokenAuthMethod?: "client_secret_post" | "client_secret_basic" | "none";
    /** Optional explicit client_id (DCR or user-supplied). */
    clientId?: string;
    /** Optional explicit client_secret (omitted for `none`). */
    clientSecret?: string;
    /**
     * Reconnect / upgrade-scopes target. When set, the callback hands
     * this id to `saveIntegrationConnection` so the existing row is
     * UPDATED in place (token refreshed, scopes possibly broadened)
     * instead of inserting a duplicate. Absent = fresh connect, always
     * INSERT.
     */
    connectionId?: string;
  };
}

/**
 * Ephemeral OAuth state store — keyed by `state` (OAuth2) or `oauth_token` (OAuth1a).
 * Implementations are expected to enforce TTL; expired records must be treated as absent.
 * In-process Redis or local-memory impls are injected by the platform layer.
 */
export interface OAuthStateStore {
  set(key: string, record: OAuthStateRecord, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<OAuthStateRecord | null>;
  delete(key: string): Promise<void>;
}

export interface ScopeValidationResult {
  sufficient: boolean;
  granted: string[];
  required: string[];
  missing: string[];
}
