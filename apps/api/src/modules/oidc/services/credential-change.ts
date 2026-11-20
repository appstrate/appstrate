// SPDX-License-Identifier: Apache-2.0

/**
 * Called by core's `endOtherAccessAfterCredentialChange` (`packages/db`) after a
 * password change or reset. Ending a session reaches none of this: the OAuth
 * provider spares `offline_access` refresh tokens, and CLI families and
 * approved device codes are bound to no session.
 */
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { deviceCode } from "@appstrate/db/schema";
import {
  deleteOAuthTokens,
  raiseMcpWatermarksOfUser,
} from "../../../services/oauth-token-revocation.ts";
import { revokeAllFamiliesForUser } from "./cli-tokens.ts";

export async function revokeOidcAccessAfterCredentialChange(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(deviceCode).where(eq(deviceCode.userId, userId));
    // Deleted, not marked: see `oauth-token-revocation.ts`.
    await deleteOAuthTokens(tx, (table) => eq(table.userId, userId));
    // After the deletes, so a refresh that read a token before them is refused.
    // Consents stay: the user did not revoke the client.
    await raiseMcpWatermarksOfUser(tx, userId);
  });
  await revokeAllFamiliesForUser(userId, "password_changed");
}
