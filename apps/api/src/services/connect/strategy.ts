// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestration-side `connect` strategy contract (spec §4.7 boundary).
 *
 * The pure `ConnectStrategy` (in `@appstrate/connect/connect`) documents the
 * canonical shape — `complete` produces a {@link CredentialBundle}. Here, in
 * apps/api, the strategies additionally PERSIST (they own the DB) and so
 * return the persisted {@link IntegrationConnectionSummary}. They realize the
 * pure contract by building a bundle internally and routing it through the
 * single `persistCredentialBundle` writer.
 *
 * `reacquire` (Phase 2) returns a bare `CredentialBundle` — its consumer (the
 * live credentials resolver) wants the refreshed fields, not a summary.
 */

import type {
  ConnectContext,
  BeginOptions,
  BeginResult,
  CredentialBundle,
} from "@appstrate/connect/connect";
import type { IntegrationOAuthCallbackResult } from "@appstrate/connect";
import type { IntegrationConnectionSummary } from "../integration-connections.ts";
import type {
  IntegrationRefreshContext,
  IntegrationRefreshResult,
} from "../integration-token-refresh.ts";

export type { ConnectContext, BeginOptions, BeginResult, CredentialBundle };
export type { IntegrationRefreshResult };

/**
 * Inputs for {@link IntegrationConnectStrategy.reacquire}. The live credential
 * resolvers (MITM + api_call proxy) hold the encrypted blob + the per-app
 * OAuth refresh context, not a decrypted {@link CredentialBundle} — so the
 * orchestration `reacquire` takes the resolver's shape and returns the rich
 * {@link IntegrationRefreshResult} (fields + expiry + granted scopes + shrink
 * flag) those hot paths consume.
 */
export interface ReacquireInput {
  connectionId: string;
  packageId: string;
  authKey: string;
  credentialsEncrypted: string;
  refreshContext: IntegrationRefreshContext;
}

/**
 * Terminal acquisition input for the orchestration layer.
 *
 * `oauth2-result` carries the already-exchanged callback result: the token
 * exchange (and its `OAuthCallbackError` UX mapping) stays in the stateless
 * /callback route because the actor/scope context is reconstructed from the
 * signed OAuth state during the exchange. The strategy then does identity
 * extraction + persist.
 */
export type ConnectCompleteInput =
  | { kind: "oauth2-result"; result: IntegrationOAuthCallbackResult }
  | { kind: "fields"; credentials: Record<string, string> };

export interface IntegrationConnectStrategy {
  /** Interactive step (OAuth2 only): authorize URL + state. */
  begin?(ctx: ConnectContext, opts: BeginOptions): Promise<BeginResult>;
  /** Terminal acquisition → persisted connection summary. */
  complete(ctx: ConnectContext, input: ConnectCompleteInput): Promise<IntegrationConnectionSummary>;
  /**
   * Re-acquisition (Phase 2). Present on OAuth2Strategy (fast-path
   * refresh_token POST); absent on FieldsStrategy — a 401 on a paste-the-bag
   * connection cannot be auto-recovered and surfaces as needsReconnection.
   */
  reacquire?(input: ReacquireInput): Promise<IntegrationRefreshResult>;
}
