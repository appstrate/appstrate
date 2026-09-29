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

/**
 * The write controls a connection row offers, on the rules the API enforces
 * (every write also guards on `integrations:connect`, whoever owns the row):
 * rename is the owner's or a governor's (`integrations:configure`); sharing is
 * the owner's consent, and a governor can only WITHDRAW a share — so a
 * colleague's unshared row offers them no toggle. While an admin pin or the
 * space default names the row (`locked`), unsharing it is refused (409
 * `connection_pinned`): the toggle stays, disabled (`shareLocked`).
 */
export function connectionRowGrants(args: {
  isOwn: boolean;
  isShared: boolean;
  canConnect: boolean;
  canConfigure: boolean;
  locked: boolean;
}): { canRename: boolean; canToggleShare: boolean; shareLocked: boolean } {
  const canRename = args.canConnect && (args.isOwn || args.canConfigure);
  return {
    canRename,
    canToggleShare: (args.isOwn && args.canConnect) || (args.isShared && canRename),
    shareLocked: args.locked && args.isShared,
  };
}
