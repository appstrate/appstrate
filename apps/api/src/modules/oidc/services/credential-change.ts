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
  await db.delete(deviceCode).where(eq(deviceCode.userId, userId));
  // Deleted, not marked revoked: a marked token presented again after the user
  // reconnects would make Better Auth wipe the new grant (`oauth-token-revocation.ts`).
  await deleteOAuthTokens(db, (table) => eq(table.userId, userId));
  // An MCP access token is a JWT no row backs: its grant's watermark refuses
  // it. Raised after the deletes, so a refresh that read a token before them
  // is refused too. Consents stay: the user did not revoke the client.
  await raiseMcpWatermarksOfUser(db, userId);
  await revokeAllFamiliesForUser(userId, "password_changed");
}
