// SPDX-License-Identifier: Apache-2.0

interface ConnectionOwnerFields {
  owner_type: "user" | "end_user";
  owner_id: string;
}

/** Lists include rows shared by others; only the (type, id) pair identifies the owner. */
export function isConnectionOwnedBy(c: ConnectionOwnerFields, userId: string | undefined): boolean {
  return c.owner_type === "user" && !!userId && c.owner_id === userId;
}

/** `settings` key for why a locked connection refuses unshare/delete; null when unlocked. */
export function connectionLockHintKey(
  lockedBy: "admin_pin" | "org_default" | null | undefined,
  canConfigure: boolean,
) {
  if (!lockedBy) return null;
  if (lockedBy === "admin_pin") {
    return canConfigure
      ? "integration.connection.lock.adminPin"
      : "integration.connection.lock.adminPinAsk";
  }
  return canConfigure
    ? "integration.connection.lock.orgDefault"
    : "integration.connection.lock.orgDefaultAsk";
}
