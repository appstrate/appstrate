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

/**
 * An agent's `dependencies.integrations` entry flattened by
 * `parseManifestIntegrations` (`@appstrate/core/integration`): the bare
 * version dep merged with the optional top-level `integrations[id]`
 * tool/scope selection. Shared so the backend (`AgentDetail`) and the
 * frontend agent-integrations block read one definition.
 */
export interface AgentIntegrationEntry {
  id: string;
  version: string;
  tools?: string[];
  scopes?: string[];
}

export interface IntegrationSummary {
  id: string;
  manifest: IntegrationManifestView;
  orgId: string | null;
  source: "local" | "system";
  /** True when an application_packages row exists for this (app, integration). */
  active?: boolean;
  /** Admin-only per-(app, integration) lock; defaults to false when inactive. */
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
/**
 * Per-agent breakdown of scope contributions — the audit / "which agent
 * asked for this permission" surface. Shared wire element: the backend
 * resolver builds it, the frontend renders it.
 */
export interface ScopeBreakdownEntry {
  /** Fully-scoped agent package id (`@scope/name`). */
  agentId: string;
  /** Scopes inferred from the agent's declared (or implicit) `tools[]`. */
  viaTools: string[];
  /** Scopes the agent declared explicitly via `scopes[]`. */
  viaExplicit: string[];
}

export interface IntegrationRequiredScopes {
  defaults: string[];
  required: string[];
  granted: string[];
  union: string[];
  missingFromGranted: string[];
  breakdown: ScopeBreakdownEntry[];
}

/**
 * One connection an actor can pick from for a given (application,
 * integration): own + shared-with-org, with caller-facing display fields.
 * Wire shape for `GET /api/integrations/:packageId/accessible-connections`.
 */
export interface AccessibleIntegrationConnection {
  id: string;
  authKey: string;
  accountId: string;
  label: string | null;
  ownerUserId: string | null;
  ownerEndUserId: string | null;
  /** Display name of the connection's creator (null if owner row deleted). */
  ownerName: string | null;
  /** OAuth scopes granted to this connection (empty for api_key/basic). */
  scopesGranted: string[];
  sharedWithOrg: boolean;
  needsReconnection: boolean;
}

/**
 * An admin pin (`integration_pins`, `user_id IS NULL`) governing which
 * connection an agent uses for an integration. Wire shape for the
 * `/api/integrations/:packageId/pins` surface.
 */
export interface IntegrationPin {
  packageId: string;
  integrationPackageId: string;
  /** Denormalised from the pinned connection — display hint only. */
  authKey: string;
  connectionId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Org-wide default connection for an integration (all consuming agents).
 * `enforce: true` locks members; `false` is a soft default they can
 * override with their own pin. See the resolver cascade.
 */
export interface IntegrationOrgDefault {
  integrationPackageId: string;
  connectionId: string;
  /** Denormalised from the default connection — display hint only. */
  authKey: string;
  enforce: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An installed agent that declares a given integration as a dependency. */
export interface ConsumingAgentSummary {
  packageId: string;
  displayName: string;
}

/**
 * One accessible connection annotated for the agent-page picker — adds the
 * scopes the agent's selected tools require that the connection lacks, and
 * whether the calling actor owns it.
 */
export interface IntegrationCandidate extends AccessibleIntegrationConnection {
  missingScopes: string[];
  isOwn: boolean;
}

/**
 * The picker verdict for a given (agent, integration, actor). Computed
 * server-side by the same resolver cascade the runtime uses, so the
 * agent-page dropdown never re-implements (and never drifts from) the
 * "which connection does this run use?" logic.
 *
 *  - `admin_locked` — an admin pin forces the choice (dropdown disabled).
 *  - `pinned`       — the actor's own member pin resolves.
 *  - `auto`         — no pin, exactly one accessible connection.
 *  - `must_choose`  — no pin, more than one candidate (member must pick).
 *  - `none`         — no accessible connection.
 *  - `stale`        — a pin points at a connection no longer accessible.
 *  - `needs_reconnection` — the resolved connection is flagged for re-consent.
 */
export type IntegrationPickStatus =
  | "admin_locked"
  | "pinned"
  | "auto"
  | "must_choose"
  | "none"
  | "stale"
  | "needs_reconnection";

export interface IntegrationAgentResolution {
  status: IntegrationPickStatus;
  /** Connection the next run would use, or null for none/must_choose/stale. */
  resolvedConnectionId: string | null;
  /** Missing scopes on the resolved connection (empty unless under-scoped). */
  resolvedMissingScopes: string[];
  /** True when the resolved connection belongs to the calling actor. */
  resolvedOwnedByActor: boolean;
  /** Admin pin connection id (status admin_locked), else null. */
  adminPinnedConnectionId: string | null;
  /** The actor's own member pin connection id, else null. */
  memberPinnedConnectionId: string | null;
  /**
   * Org-wide default connection id for this integration (all agents), or
   * null when unset. `orgDefaultEnforced` distinguishes a hard lock
   * (members can't override — surfaced like an admin pin) from a soft
   * default the member can still override with their own pick.
   */
  orgDefaultConnectionId: string | null;
  orgDefaultEnforced: boolean;
  /** Whether the actor may add a connection (admin OR not blocked). */
  canAddConnection: boolean;
  /** Own + shared connections, annotated for the dropdown. */
  candidates: IntegrationCandidate[];
}
