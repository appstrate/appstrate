// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The sign-in rules of an organization's domains, as pure decisions. The
 * Better Auth plugin (`auth-plugin.ts`) classifies what is happening and asks
 * here; nothing in this file reads a request or a table.
 */

import { normalizeAddress } from "./domain.ts";
import type { DomainPolicy } from "./store.ts";

/** A session of an enforced domain lives at most this long from its creation, never slid. */
export const ENFORCED_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How a session is being opened, as far as these rules care. */
export type SessionOrigin =
  /**
   * The Microsoft callback, with the tenant (`tid`) and the address (`email`
   * claim) of the identity it signed in.
   */
  | { kind: "microsoft"; tenantId: string | null; email: string | null }
  /** The emergency password sign-in of an owner of the enforcing organization. */
  | { kind: "break_glass" }
  /** A live session of the same account replaced by a new one (password change). */
  | { kind: "rotation"; replacedCreatedAt: Date }
  /** Anything else: password, magic link, Google, GitHub, a method added later. */
  | { kind: "other" };

export type SsoRefusal = "sso_required" | "sso_tenant_mismatch";

export type SessionDecision =
  /**
   * `createdAt`, when set, replaces the new session's creation time: a session
   * replacing another carries the original's, so neither it nor its refreshes
   * outlive the original's cap, however many times it is replaced.
   */
  { allow: true; expiresAt: Date; createdAt?: Date } | { allow: false; code: SsoRefusal };

/**
 * Whether a Microsoft identity speaks for `address`: the bound tenant, and the
 * address itself. A member of the tenant linking their own identity to another
 * person's account must not open that account's sessions, nor join for it.
 */
export function microsoftVouchesFor(
  policy: DomainPolicy,
  identity: { tenantId: string | null; email: string | null },
  address: string,
): boolean {
  const claimed = identity.email ? normalizeAddress(identity.email) : null;
  return (
    identity.tenantId === policy.tenantId &&
    claimed !== null &&
    claimed === normalizeAddress(address)
  );
}

/**
 * May a session be opened for `address`, of a domain under `policy`, and until
 * when? A fail-closed allowlist: once the domain is enforced, only the origins
 * named here open a session, so a sign-in method added later is refused until
 * someone decides otherwise.
 */
export function decideSession(
  policy: DomainPolicy | null,
  origin: SessionOrigin,
  address: string,
  requestedExpiresAt: Date,
  now: Date,
): SessionDecision {
  if (!policy) return { allow: true, expiresAt: requestedExpiresAt };
  // Enforced or not, a Microsoft sign-in for an address of a proven domain is
  // that address's own identity in the tenant the organization bound.
  if (origin.kind === "microsoft" && !microsoftVouchesFor(policy, origin, address)) {
    return { allow: false, code: "sso_tenant_mismatch" };
  }
  if (!policy.enforced) return { allow: true, expiresAt: requestedExpiresAt };
  switch (origin.kind) {
    case "microsoft":
    case "break_glass":
      return {
        allow: true,
        expiresAt: earliest(requestedExpiresAt, now.getTime() + ENFORCED_SESSION_MAX_AGE_MS),
      };
    case "rotation":
      // The new session inherits the creation time, hence the deadline, of the one it replaces.
      return {
        allow: true,
        expiresAt: earliest(
          requestedExpiresAt,
          origin.replacedCreatedAt.getTime() + ENFORCED_SESSION_MAX_AGE_MS,
        ),
        createdAt: origin.replacedCreatedAt,
      };
    case "other":
      return { allow: false, code: "sso_required" };
  }
}

/** The expiry a refresh may write for a session of an enforced domain: never past its cap. */
export function cappedRefresh(createdAt: Date, requestedExpiresAt: Date): Date {
  return earliest(requestedExpiresAt, createdAt.getTime() + ENFORCED_SESSION_MAX_AGE_MS);
}

function earliest(date: Date, epochMs: number): Date {
  return date.getTime() <= epochMs ? date : new Date(epochMs);
}
