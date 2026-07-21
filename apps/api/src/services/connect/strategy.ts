// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestration-side `connect` strategy contract (spec §4.7 boundary).
 *
 * The ambient context/option types live HERE (apps/api is their only consumer);
 * the strategies additionally PERSIST (they own the DB) and so return the
 * persisted {@link IntegrationConnectionSummary}. They realize the contract by
 * building a bundle internally and routing it through the single
 * `persistCredentialBundle` writer.
 *
 * Re-acquisition is OAuth2-only and is a direct call to
 * `forceRefreshIntegrationConnection` from the live resolvers — not a strategy
 * method — because the only refreshable auth type is `oauth2`.
 */

import type { Actor, IntegrationOAuthCallbackResult } from "@appstrate/connect";
import type { CredentialBundle } from "@appstrate/connect/connect";
import type { BrowserProviderBinding } from "@appstrate/core/sidecar-types";
import type { IntegrationConnectionSummary, PersistTarget } from "../integration-connections.ts";
import { invalidRequest } from "../../lib/errors.ts";

export type { CredentialBundle };

/**
 * Ambient context handed to every strategy call: who is connecting, to which
 * integration auth, and (for reconnect/upgrade) which existing row to target.
 */
export interface ConnectContext {
  scope: { orgId: string; applicationId: string };
  actor: Actor;
  integrationId: string;
  authKey: string;
  /** Reconnect / scope-upgrade target. Absent on a fresh connect. */
  connectionId?: string;
  /** Trusted provider/profile allocation for a companion handoff. */
  browserProviderBinding?: BrowserProviderBinding;
  /** Browser connect only: forward a human-in-the-loop live session. */
  onBrowserInteractionRequired?: (interaction: { url: string }) => void | Promise<void>;
  /** Browser connect only: stop acquisition if the hosted client disconnects. */
  signal?: AbortSignal;
}

/** Options for the interactive `begin` step (OAuth2 authorize URL). */
export interface BeginOptions {
  /** Final scope set requested in the authorize URL (already unioned). */
  scopes?: string[];
  /** Force the IdP account picker (explicit "add another connection"). */
  forceAccountSelect?: boolean;
}

/** Result of `begin` — a browser redirect plus the CSRF/correlation state. */
export interface BeginResult {
  redirectUrl: string;
  state: string;
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
  // `credentials` is typed `Record<string, unknown>` because JSON Schema
  // 2020-12 §7.5 permits credential field values of any JSON type (number,
  // boolean, object, array) — narrowing to `string` would silently reject
  // well-formed non-string credential shapes before the manifest's
  // `credentials.schema` (AJV) ever sees them.
  | { kind: "fields"; credentials: Record<string, unknown> };

export interface IntegrationConnectStrategy {
  /** Interactive step (OAuth2 only): authorize URL + state. */
  begin?(ctx: ConnectContext, opts: BeginOptions): Promise<BeginResult>;
  /** Terminal acquisition → persisted connection summary. */
  complete(ctx: ConnectContext, input: ConnectCompleteInput): Promise<IntegrationConnectionSummary>;
}

// ─────────────────────────────────────────────
// Shared `complete()` guards (every non-OAuth strategy uses these)
// ─────────────────────────────────────────────

/**
 * Assert the terminal acquisition input is the `fields` shape that every
 * non-OAuth strategy's `complete()` requires, and return its credentials.
 */
export function assertFieldsInput(
  input: ConnectCompleteInput,
  strategyName: string,
): Record<string, unknown> {
  if (input.kind !== "fields") {
    throw new Error(`${strategyName}.complete: unexpected input kind '${input.kind}'`);
  }
  return input.credentials;
}

/** Reject an empty credential bag with the shared `invalidRequest` UX. */
export function requireNonEmptyCredentials(credentials: Record<string, unknown>): void {
  if (!credentials || Object.keys(credentials).length === 0) {
    throw invalidRequest("credentials payload cannot be empty", "credentials");
  }
}

/**
 * Build the {@link PersistTarget} for a strategy write: an owner-scoped update
 * when reconnecting an existing connection, otherwise a fresh insert.
 */
export function connectionTarget(ctx: ConnectContext): PersistTarget {
  return ctx.connectionId
    ? {
        kind: "update-owned",
        scope: ctx.scope,
        actor: ctx.actor,
        connectionId: ctx.connectionId,
        // Re-stamp (integrationId, authKey) into the update target so a
        // caller-supplied `connectionId` for a different integration matches
        // zero rows instead of overwriting an unrelated connection.
        packageId: ctx.integrationId,
        authKey: ctx.authKey,
      }
    : { kind: "insert", scope: ctx.scope, actor: ctx.actor };
}
