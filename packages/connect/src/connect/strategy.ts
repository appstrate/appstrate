// SPDX-License-Identifier: Apache-2.0

/**
 * `connect` — the pure ambient types shared by every acquisition path (spec §4.1).
 *
 * The concrete strategy interface that persists / reads Redis lives in
 * `apps/api/src/services/connect/` (spec §4.7 boundary). This module stays
 * import-cost-free so the published package and the sidecar can share these
 * context/option shapes.
 */

import type { Actor } from "../types.ts";

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
  integrationId: string;
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
