// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestration-side `connect` strategy contract (spec §4.7 boundary).
 *
 * The pure context/option types (in `@appstrate/connect/connect`) document the
 * canonical shapes. Here, in apps/api, the strategies additionally PERSIST
 * (they own the DB) and so return the persisted
 * {@link IntegrationConnectionSummary}. They realize the contract by building a
 * bundle internally and routing it through the single `persistCredentialBundle`
 * writer.
 *
 * Re-acquisition is OAuth2-only and is a direct call to
 * `forceRefreshIntegrationConnection` from the live resolvers — not a strategy
 * method — because the only refreshable auth type is `oauth2`.
 */

import type {
  ConnectContext,
  BeginOptions,
  BeginResult,
  CredentialBundle,
} from "@appstrate/connect/connect";
import type { IntegrationOAuthCallbackResult } from "@appstrate/connect";
import type { IntegrationConnectionSummary } from "../integration-connections.ts";

export type { ConnectContext, BeginOptions, BeginResult, CredentialBundle };

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
}
