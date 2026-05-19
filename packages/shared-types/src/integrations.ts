// SPDX-License-Identifier: Apache-2.0

/**
 * Shared wire types for the AFPS integration marketplace. Used on both
 * the backend (`apps/api/src/services/integration-connections.ts`) and
 * the frontend (`apps/web/src/hooks/use-integrations.ts`) so neither
 * side can drift the other.
 */

import type { IntegrationManifest } from "@appstrate/core/integration";

export type IntegrationManifestView = IntegrationManifest;
export type IntegrationManifestAuth = NonNullable<IntegrationManifest["auths"]>[string];
export type IntegrationManifestTool = NonNullable<IntegrationManifest["tools"]>[string];
export type IntegrationAuthType = IntegrationManifestAuth["type"];

export interface IntegrationSummary {
  id: string;
  manifest: IntegrationManifestView;
  orgId: string | null;
  source: "local" | "system";
  installed?: boolean;
  /** Admin-only per-(app, integration) lock; defaults to false when not installed. */
  blockUserConnections?: boolean;
}

export interface IntegrationConnection {
  id: string;
  packageId: string;
  authKey: string;
  /** Multi-account discriminator extracted at connect time. */
  accountId: string;
  /** Identity claims surfaced for the UI (e.g. `account_email`). */
  identityClaims: Record<string, unknown> | null;
  scopesGranted: string[];
  needsReconnection: boolean;
  expiresAt: string | null;
  ownerType: "user" | "end_user";
  ownerId: string;
  /** User-set display name ("Perso", "Boulot"). */
  label?: string | null;
  /** Opt-in: makes this connection selectable by other members of the same app. */
  sharedWithOrg?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationAuthStatus {
  authKey: string;
  type: IntegrationAuthType;
  required: boolean;
  /** Scopes declared in the manifest (the ones the connect button requests). */
  scopes: string[];
  audience: string | null;
  /** Connections the calling actor has for this auth (multi-account = >1). */
  connections: IntegrationConnection[];
  /** True when this auth has an admin-registered OAuth2 client (oauth2 only). */
  hasOAuthClient: boolean;
}

export interface IntegrationDetail {
  manifest: IntegrationManifestView;
  auths: IntegrationAuthStatus[];
}

export interface IntegrationOAuthClient {
  applicationId: string;
  integrationPackageId: string;
  authKey: string;
  clientId: string;
  /** True when the client_secret blob is non-empty (private client). */
  hasClientSecret: boolean;
  redirectUri: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Niveau 2 Phase 5 — wire shape for
 * `GET /api/integrations/:packageId/auths/:authKey/required-scopes`.
 *
 *  - `defaults` — manifest defaults for this auth.
 *  - `required` — union of `requiredScopes` across every installed agent
 *    that depends on this integration (filtered by `requiredAuthKey` for
 *    multi-auth integrations).
 *  - `granted` — actor's current high-water-mark across all their
 *    connections on this integration auth.
 *  - `union` — `defaults ∪ required ∪ granted` — what the OAuth kickoff
 *    will actually request (incremental consent).
 *  - `missingFromGranted` — scopes that the union demands but the actor
 *    hasn't granted yet → drives the "Reconnect to grant new
 *    permissions" CTA.
 *  - `breakdown` — per-agent decomposition for the audit / "why is this
 *    permission required?" surface.
 */
export interface IntegrationRequiredScopes {
  defaults: string[];
  required: string[];
  granted: string[];
  union: string[];
  missingFromGranted: string[];
  breakdown: Array<{
    agentId: string;
    viaTools: string[];
    viaExplicit: string[];
  }>;
}
