// SPDX-License-Identifier: Apache-2.0

import type { AuthMode, ResolvedProviderDefinition } from "@appstrate/core/validation";

export type { AuthMode };

/** Actor identity — member (dashboard) or end-user (headless). */
export type Actor = { type: "member"; id: string } | { type: "end_user"; id: string };

/** Provider definition used by the connect package — extends core's resolved type with runtime fields. */
export type ProviderDefinition = ResolvedProviderDefinition & {
  /** Whether this provider has a PROVIDER.md companion file. */
  hasProviderDoc?: boolean;
};

export interface ConnectionRecord {
  id: string;
  profileId: string;
  providerId: string;
  orgId: string;
  credentialsEncrypted: string;
  scopesGranted: string[];
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
  profileId: string;
  providerId: string;
  codeVerifier: string;
  scopesRequested: string[];
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
  authMode: string;
  oauthTokenSecret?: string;
}

export interface ScopeValidationResult {
  sufficient: boolean;
  granted: string[];
  required: string[];
  missing: string[];
}
