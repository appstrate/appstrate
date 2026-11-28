// SPDX-License-Identifier: Apache-2.0

import type { ModelCredentialOwner } from "@appstrate/core/model-payer";

/** The caller's own personal credentials, out of an org-wide list (a reader gets every member's). */
export function ownPersonalCredentials<
  T extends { owner_type: ModelCredentialOwner; owner_id: string | null },
>(credentials: readonly T[], userId: string | undefined): T[] {
  if (!userId) return [];
  return credentials.filter((c) => c.owner_type === "user" && c.owner_id === userId);
}
