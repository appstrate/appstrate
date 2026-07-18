// SPDX-License-Identifier: Apache-2.0

/**
 * Shared wire types for the AFPS integration marketplace. Used on both
 * the backend (`apps/api/src/services/integration-connections.ts`) and
 * the frontend (`apps/web/src/hooks/use-integrations.ts`) so neither
 * side can drift the other.
 */

import type { IntegrationManifest, IntegrationToolCatalogEntry } from "@appstrate/core/integration";

export type IntegrationManifestView = IntegrationManifest;
export type IntegrationManifestAuth = NonNullable<IntegrationManifest["auths"]>[string];
export type IntegrationAuthType = IntegrationManifestAuth["type"];

/**
 * An agent's integration declaration flattened by `parseManifestIntegrations`:
 * the version from `dependencies.integrations[id]` (§4.1) merged with the
 * optional `integrations_configuration[id]` tool/scope/auth selection (§4.4).
 * Structurally identical to core's `ManifestIntegrationEntry` (the return shape
 * of that parser), so it is
 * re-exported under the agent-facing name rather than duplicated — backend
 * (`AgentDetail`) and frontend read one definition that cannot drift.
 */
export type { ManifestIntegrationEntry as AgentIntegrationEntry } from "@appstrate/core/dependencies";

export interface IntegrationSummary {
  id: string;
  manifest: IntegrationManifestView;
  orgId: string | null;
  source: "local" | "system";
  /** True when an application_packages row exists for this (app, integration). */
  active?: boolean;
  /** Admin-only per-(app, integration) lock; defaults to false when inactive. */
  block_user_connections?: boolean;
}

export interface IntegrationConnection {
  id: string;
  packageId: string;
  auth_key: string;
  /** Multi-account discriminator extracted at connect time. */
  account_id: string;
  /** Identity claims extracted via `extractTokenIdentity` (e.g. `sub`, `email`). */
  identity_claims: Record<string, unknown> | null;
  scopes_granted: string[];
  needs_reconnection: boolean;
  expiresAt: string | null;
  owner_type: "user" | "end_user";
  owner_id: string;
  /**
   * Display name, set at creation: the extracted identity (email/login) when
   * available, else "Connexion N". Stable for the connection's lifetime and
   * user-editable. The UI renders it verbatim.
   */
  label?: string | null;
  /** Opt-in: makes this connection selectable by other members of the same app. */
  shared_with_org?: boolean;
  /**
   * The registered OAuth client that minted this connection — a flat client id
   * (system env id or `integration_oauth_clients.id`). `null` for non-oauth2
   * auths (no client). A connection is bound to it (token refresh uses the same
   * client), so changing it requires reconnecting. Can be resolved against the
   * clients list to show which client minted each connection.
   */
  client_ref: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationAuthStatus {
  auth_key: string;
  type: IntegrationAuthType;
  required: boolean;
  /** Scopes declared in the manifest (the ones the connect button requests). */
  scopes: string[];
  /**
   * RFC 8707 resource indicator declared by the manifest
   * (`auths.{key}.resource`). AFPS §7.3 name — matches the RFC.
   */
  resource: string | null;
  /** Connections the calling actor has for this auth (multi-account = >1). */
  connections: IntegrationConnection[];
  /**
   * Server-authoritative usability: true when ≥1 connection here is not flagged
   * for reconnection. Single source so UIs (chat connect card, …) never
   * re-derive connection state. Agent-agnostic — a run's authoritative
   * readiness still comes from the resolver via `validateInlineRun`.
   */
  ready: boolean;
  /** True when this auth has an admin-registered OAuth2 client (oauth2 only). */
  has_oauth_client: boolean;
  /**
   * True when the platform provides a shared system OAuth client for this auth
   * via `SYSTEM_INTEGRATIONS` (oauth2 only). The connect flow falls back
   * to it when the org has not registered its own client, so the UI treats the
   * auth as connectable. Mirrors the model-provider system-key fallback.
   */
  has_system_client: boolean;
  /**
   * True for an oauth2 auth on a remote MCP integration (`source.kind:
   * "remote"`). Per the MCP Authorization spec the OAuth client is provisioned
   * automatically at connect time — the flow discovers the authorization server
   * (RFC 9728 → RFC 8414) and obtains a client without manual pre-registration
   * (CIMD when advertised, else RFC 7591 dynamic registration). The UI therefore
   * treats the auth as connectable even without a pre-registered client. Named
   * for the capability (auto-provisioned client), not the specific mechanism, so
   * it stays accurate once CIMD lands alongside DCR.
   */
  client_auto_provisioned: boolean;
}

/**
 * One entry in the agent-facing tool catalog the picker consumes. Resolved
 * server-side by `resolveIntegrationToolCatalog` from the referenced
 * mcp-server's MCPB `tools[]` minus `hidden_tools` and auto-hidden
 * connect.tool primitives. Falls back to the integration's sparse
 * `tools_policy{}` keys when the mcp-server is unavailable. Per-tool `policy`
 * is attached verbatim from `integration.tools_policy[name]` when declared.
 *
 * Re-exported from `@appstrate/core` rather than duplicated: the resolver
 * already emits this exact wire shape (snake_case `policy.required_scopes`),
 * so backend producer and frontend consumer read one definition.
 */
export type { IntegrationToolCatalogEntry };

export interface IntegrationDetail {
  manifest: IntegrationManifestView;
  auths: IntegrationAuthStatus[];
  /** Effective agent-facing tool catalog — the picker's source of truth. */
  tool_catalog: IntegrationToolCatalogEntry[];
  /**
   * AFPS §7.8 opt-in surfaced verbatim from the integration manifest.
   * When `true`, the agent editor's tool picker MAY offer the
   * "Include all upstream tools (advanced)" toggle that sets
   * `integrations_configuration.<id>.tools = "*"`.
   */
  allow_undeclared_tools: boolean;
  /**
   * Activation state in the current application — `true` when an enabled
   * application_packages row exists. Resource state shared with the list
   * endpoint; returned by every detail-shaped response (GET detail,
   * POST activate, PATCH settings) per #657.
   */
  active: boolean;
  /**
   * Admin gate: when `true`, only org admins may create personal
   * connections in this application. `false` when not activated.
   */
  block_user_connections: boolean;
}

export interface IntegrationOAuthClient {
  /** Row UUID — the `client_ref` handle for rotate / delete / default-client. */
  id: string;
  applicationId: string;
  integration_package_id: string;
  auth_key: string;
  client_id: string;
  /** True when the client_secret blob is non-empty (private client). */
  has_client_secret: boolean;
  redirect_uri: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One connection an actor can pick from for a given (application,
 * integration): own + shared-with-org, with caller-facing display fields.
 * Base wire shape for the annotated candidate list surfaced by
 * `GET /api/agents/:scope/:name/connection-readiness`
 * (extended by `IntegrationCandidate`).
 */
export interface AccessibleIntegrationConnection {
  id: string;
  auth_key: string;
  account_id: string;
  label: string | null;
  owner_user_id: string | null;
  owner_end_user_id: string | null;
  /** Display name of the connection's creator (null if owner row deleted). */
  owner_name: string | null;
  /** OAuth scopes granted to this connection (empty for api_key/basic). */
  scopes_granted: string[];
  shared_with_org: boolean;
  needs_reconnection: boolean;
}

/**
 * An admin pin (`integration_pins`, `user_id IS NULL`) governing which
 * connection an agent uses for an integration. Wire shape for the
 * `/api/integrations/:packageId/pins` surface.
 */
export interface IntegrationPin {
  packageId: string;
  integration_package_id: string;
  /** Denormalised from the pinned connection — display hint only. */
  auth_key: string;
  connection_id: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Org-wide default connection for an integration (all consuming agents).
 * `enforce: true` locks members; `false` is a soft default they can
 * override with their own pin. See the resolver cascade.
 */
export interface IntegrationOrgDefault {
  integration_package_id: string;
  connection_id: string;
  /** Denormalised from the default connection — display hint only. */
  auth_key: string;
  enforce: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An installed agent that declares a given integration as a dependency. */
export interface ConsumingAgentSummary {
  packageId: string;
  display_name: string;
}

/**
 * One accessible connection annotated for the agent-page picker — adds the
 * scopes the agent's selected tools require that the connection lacks, and
 * whether the calling actor owns it.
 */
export interface IntegrationCandidate extends AccessibleIntegrationConnection {
  missing_scopes: string[];
  is_own: boolean;
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
  "admin_locked" | "pinned" | "auto" | "must_choose" | "none" | "stale" | "needs_reconnection";

export interface IntegrationAgentResolution {
  status: IntegrationPickStatus;
  /** Connection the next run would use, or null for none/must_choose/stale. */
  resolved_connection_id: string | null;
  /** Missing scopes on the resolved connection (empty unless under-scoped). */
  resolved_missing_scopes: string[];
  /** True when the resolved connection belongs to the calling actor. */
  resolved_owned_by_actor: boolean;
  /** Admin pin connection id (status admin_locked), else null. */
  admin_pinned_connection_id: string | null;
  /** The actor's own member pin connection id, else null. */
  member_pinned_connection_id: string | null;
  /**
   * Org-wide default connection id for this integration (all agents), or
   * null when unset. `orgDefaultEnforced` distinguishes a hard lock
   * (members can't override — surfaced like an admin pin) from a soft
   * default the member can still override with their own pick.
   */
  org_default_connection_id: string | null;
  org_default_enforced: boolean;
  /** Whether the actor may add a connection (admin OR not blocked). */
  can_add_connection: boolean;
  /** Own + shared connections, annotated for the dropdown. */
  candidates: IntegrationCandidate[];
}
