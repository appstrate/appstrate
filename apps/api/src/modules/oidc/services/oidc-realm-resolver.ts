// SPDX-License-Identifier: Apache-2.0

/**
 * Realm resolver — decides the `user.realm` value assigned to a brand-new
 * Better Auth user at creation time.
 *
 * Installed via `setRealmResolver()` during the OIDC module's `init()`.
 * Derives the in-flight OAuth client from the TRANSACTION BINDING
 * (`resolvePendingClientBinding` — OAuth callback state, magic-link token
 * binding, or the server-authored pending-client cookie on the register
 * path), looks up the client's signup policy (which already resolves
 * `applicationId` from the `level=application` branch), and returns:
 *
 *   - `"end_user:<applicationId>"` when the binding pins an application-level
 *     client. This is the single-user-pool isolation fix that prevents the
 *     newly minted BA user from being replayable against platform routes.
 *   - `"platform"` for org-level clients (whose users are real platform
 *     members auto-joined to the org), instance-level clients (satellite
 *     dashboards, themselves platform audiences), and the no-binding case
 *     (direct dashboard signup, invitation flow, any non-OIDC BA sign-up).
 *
 * FAIL-CLOSED (CRIT-15). A resolvable transaction binding is a POSITIVE
 * marker that this signup is happening inside an OIDC transaction. Within
 * such a transaction the realm MUST resolve to a coherent audience — we
 * never silently downgrade an un-resolvable OIDC flow to a full `platform`
 * user (that user would pass `requirePlatformRealm` on every platform
 * route). So a binding that names an unknown/disabled client, an
 * application-level client with no `applicationId`, or an OAuth transaction
 * whose authorize destination carries no `client_id`, ABORTS user creation
 * instead of defaulting to `platform`. The ONLY path that resolves to
 * `platform` is one POSITIVELY established as non-OIDC:
 *
 *   - a social/OAuth callback whose server-stored `callbackURL` (fixed at
 *     initiation, keyed by the single-use OAuth `state`, consumed by Better
 *     Auth itself) does not resume our authorize endpoint — a plain
 *     dashboard social sign-in;
 *   - a magic-link verify whose token has no server-side binding AND whose
 *     request carries no pending-client cookie — a direct call against BA's
 *     public magic-link endpoint;
 *   - any other creation with no binding at all — core dashboard signup,
 *     invitation flow.
 *
 * Transaction binding per leg (all three create legs are closed):
 *   - email/password register → `POST /api/oauth/register` re-mints an
 *     authoritative cookie header from the validated authorize query
 *     (`headersWithAuthoritativePendingClient`);
 *   - social callback → BA's request-scoped OAuth state, keyed by the
 *     single-use `state` parameter (browser cannot strip or clobber it);
 *   - magic-link verify → server-side `(sha256(token) → clientId)` record
 *     written at issuance by `bindIssuedMagicLink`.
 * See `services/oauth-transaction-binding.ts` for the full mechanism.
 *
 * See `packages/db/src/auth.ts::setRealmResolver` for the injection point
 * and `apps/api/src/middleware/realm-guard.ts` for the request-time
 * enforcement that consumes the resulting realm string.
 */

import { APIError } from "better-auth/api";
import type { RealmResolutionContext } from "@appstrate/db/auth";
import { resolvePendingClientBinding } from "./oauth-transaction-binding.ts";
import { loadClientSignupPolicy } from "./orgmember-mapping.ts";

function realmUnresolved(): APIError {
  return new APIError("FORBIDDEN", {
    message: "oidc_realm_unresolved",
    code: "oidc_realm_unresolved",
  });
}

export async function oidcRealmResolver(ctx: RealmResolutionContext): Promise<string> {
  const binding = await resolvePendingClientBinding(ctx);
  // No OIDC marker anywhere → genuine non-OIDC signup (core dashboard,
  // invitation, direct BA call). Established positively — see file header.
  if (binding.kind === "none") return "platform";
  if (binding.kind === "invalid") {
    // An OAuth transaction was positively detected (single-use state
    // consumed by BA) but its binding is incoherent — e.g. an authorize
    // destination without `client_id`. Fail closed rather than mint a
    // platform-realm user for an OIDC flow.
    throw realmUnresolved();
  }

  const policy = await loadClientSignupPolicy(binding.clientId);
  if (!policy) {
    // A binding is present (intentional OIDC flow) but names an
    // unknown/disabled client — we cannot establish a coherent realm.
    throw realmUnresolved();
  }
  // org / instance clients ARE platform audiences — their users are real
  // platform members. This is a legitimate `platform` resolution, not a
  // fallback.
  if (policy.level !== "application") return "platform";
  if (!policy.applicationId) {
    // Application-level client without an applicationId is a data-integrity
    // anomaly (the create schema requires `referenced_application_id`).
    // Refuse rather than downgrade an application flow to `platform`.
    throw realmUnresolved();
  }

  return `end_user:${policy.applicationId}`;
}
