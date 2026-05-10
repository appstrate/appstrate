// SPDX-License-Identifier: Apache-2.0

import type { AuthMode, ResolvedProviderDefinition } from "@appstrate/core/validation";

export type { AuthMode };

/** Actor identity — dashboard user or end-user (headless). Re-exported from `@appstrate/core/platform-types` to keep one canonical definition. */
export type { Actor } from "@appstrate/core/platform-types";

/** Provider definition used by the connect package. */
export type ProviderDefinition = ResolvedProviderDefinition;

export interface ConnectionRecord {
  id: string;
  connectionProfileId: string;
  providerId: string;
  orgId: string;
  providerCredentialId: string;
  credentialsEncrypted: string;
  scopesGranted: string[];
  needsReconnection: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecryptedCredentials {
  access_token?: string;
  refresh_token?: string;
  api_key?: string;
  username?: string;
  password?: string;
  [key: string]: string | undefined;
}

export interface OAuthStateRecord {
  state: string;
  orgId: string;
  userId: string | null;
  endUserId?: string | null;
  applicationId: string;
  connectionProfileId: string;
  providerId: string;
  codeVerifier: string;
  scopesRequested: string[];
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
  authMode: string;
  oauthTokenSecret?: string;
  /**
   * Free-form discriminator/payload bag. The shared callback router uses
   * `metadata.kind` to route the callback to the correct handler — e.g.
   * `"oauth_model_provider"` selects the model-provider flow over the
   * default integration flow. Carriers SHOULD only put primitives or
   * shallow JSON inside; the record is JSON-serialized at rest.
   */
  metadata?: Record<string, unknown>;
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
