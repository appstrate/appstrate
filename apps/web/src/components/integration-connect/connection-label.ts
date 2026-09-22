// SPDX-License-Identifier: Apache-2.0

interface ConnectionOwnerFields {
  owner_type: "user" | "end_user";
  owner_id: string;
}

/**
 * Whether a connection belongs to the signed-in dashboard user.
 *
 * The connection lists return org-shared rows owned by other members (and,
 * in a headless space, by end-users), so several controls key off
 * ownership: the delete button, the share toggle and the OAuth renew CTA are
 * owner-only server-side, and "do I already have an account connected?" must
 * not count someone else's row. Both halves of the check matter — an
 * `end_user` id could in principle collide with a user id, and only the pair
 * identifies the owner.
 */
export function isConnectionOwnedBy(c: ConnectionOwnerFields, userId: string | undefined): boolean {
  return c.owner_type === "user" && !!userId && c.owner_id === userId;
}
