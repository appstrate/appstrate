// SPDX-License-Identifier: Apache-2.0

/**
 * `connect` — the {@link ConnectStrategy} abstraction (spec §4.1).
 *
 * One interface unifies every acquisition path: OAuth2 (authorization-code +
 * PKCE), Fields (api_key/basic/custom paste), Login (declarative multi-step)
 * and Orchestrated (code connect-tool). Refresh becomes `reacquire`.
 *
 * Pure contract only — the concrete strategies that persist / read Redis live
 * in `apps/api/src/services/connect/` (spec §4.7 boundary). This module stays
 * import-cost-free so the published package and the sidecar can share it.
 */

import type { Actor } from "../types.ts";
import type { CredentialBundle } from "./types.ts";

/**
 * Ambient context handed to every strategy call: who is connecting, to which
 * integration auth, and (for reconnect/upgrade) which existing row to target.
 *
 * `proxy` is the substituting `api_call` access the code connect-tool needs
 * (Phase 4); it is absent for OAuth2/Fields/Login, which never run untrusted
 * code. Modelled optional so Phases 1–3 don't carry it.
 */
export interface ConnectContext {
  scope: { orgId: string; applicationId: string };
  actor: Actor;
  integrationPackageId: string;
  authKey: string;
  /** Reconnect / scope-upgrade target. Absent on a fresh connect. */
  connectionId?: string;
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
 * Terminal acquisition input. Discriminated by the strategy that consumes it:
 *   - OAuth2   → `{ code, state }` (callback).
 *   - Fields   → `{ credentials }` (submitted bag).
 *   - Login  → `{ credentials }` (bootstrap secrets feeding the steps).
 *   - Orchestrated → `{ credentials }` (handed to the connect-tool as inputs).
 */
export type ConnectInput =
  | { kind: "oauth2-callback"; code: string; state: string }
  | { kind: "fields"; credentials: Record<string, string> };

export interface ConnectStrategy {
  /** Optional interactive step (OAuth2): returns a browser redirect + state. */
  begin?(ctx: ConnectContext, opts: BeginOptions): Promise<BeginResult>;

  /** Terminal acquisition: callback exchange | field submit | step chain. */
  complete(ctx: ConnectContext, input: ConnectInput): Promise<CredentialBundle>;

  /** Re-acquisition: OAuth2 refresh (fast POST) | re-bootstrap. Optional. */
  reacquire?(ctx: ConnectContext, current: CredentialBundle): Promise<CredentialBundle>;
}
