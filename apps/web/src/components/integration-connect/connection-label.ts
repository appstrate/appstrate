// SPDX-License-Identifier: Apache-2.0

/**
 * Display name for an integration connection.
 *
 * `label` is the single source of truth: it's set at creation to the extracted
 * identity (email/login from `extractTokenIdentity`) or, for identity-less
 * credentials (api_key/basic/custom/PAT), to "Connexion N". The UI renders it
 * verbatim. The `?? accountId` tail only guards the optional `label` type — it
 * is always populated in practice.
 */

interface ConnectionLabelFields {
  account_id: string;
  label?: string | null;
}

/** The connection's display name. */
export function connectionDisplayLabel(c: ConnectionLabelFields): string {
  return c.label ?? c.account_id;
}

interface ConnectionOwnerFields {
  owner_type: "user" | "end_user";
  owner_id: string;
}

/**
 * Whether a connection belongs to the signed-in dashboard user.
 *
 * The connection lists return org-shared rows owned by other members (and,
 * in a headless application, by end-users), so several controls key off
 * ownership: the delete button, the share toggle and the OAuth renew CTA are
 * owner-only server-side, and "do I already have an account connected?" must
 * not count someone else's row. Both halves of the check matter — an
 * `end_user` id could in principle collide with a user id, and only the pair
 * identifies the owner.
 */
export function isConnectionOwnedBy(c: ConnectionOwnerFields, userId: string | undefined): boolean {
  return c.owner_type === "user" && !!userId && c.owner_id === userId;
}
