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
  /**
   * Integration-specific exchange parameters, carried from
   * `POST /api/integrations/:pkgId/auths/:authKey/connect/oauth2` through
   * to `handleIntegrationOAuthCallback`. `providerId` carries a sentinel
   * string for integration flows; the authoritative details live here.
   */
  integration?: {
    packageId: string;
    authKey: string;
    /**
     * Resolved token endpoint (`auths.{key}.token_endpoint`, possibly filled
     * by issuer discovery at initiate time). Carried so the callback never
     * re-resolves.
     */
    tokenEndpoint: string;
    /** Optional RFC 8707 `resource` parameter (`auths.{key}.resource`) for the token exchange. */
    resource?: string;
    /** OAuth2 token endpoint client auth method (`token_endpoint_auth_method`) declared on the auth. */
    tokenEndpointAuthMethod?: "client_secret_post" | "client_secret_basic" | "none";
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
 * Ephemeral OAuth state store — keyed by `state` (OAuth2).
 * Implementations are expected to enforce TTL; expired records must be treated as absent.
 * In-process Redis or local-memory impls are injected by the platform layer.
 */
export interface OAuthStateStore {
  set(key: string, record: OAuthStateRecord, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<OAuthStateRecord | null>;
  delete(key: string): Promise<void>;
}
