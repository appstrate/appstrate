// SPDX-License-Identifier: Apache-2.0

/**
 * Called by core's `endOtherAccessAfterCredentialChange` (`packages/db`) after a
 * password change or reset. Ending a session reaches none of this: the OAuth
 * provider spares `offline_access` refresh tokens, and CLI families and
 * approved device codes are bound to no session.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { deviceCode, oauthAccessToken, oauthRefreshToken } from "@appstrate/db/schema";
import { revokeAllFamiliesForUser } from "./cli-tokens.ts";

export async function revokeOidcAccessAfterCredentialChange(userId: string): Promise<void> {
  await db.delete(deviceCode).where(eq(deviceCode.userId, userId));
  const revokedAt = new Date();
  await db
    .update(oauthRefreshToken)
    .set({ revoked: revokedAt })
    .where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked)));
  await db
    .update(oauthAccessToken)
    .set({ revoked: revokedAt })
    .where(and(eq(oauthAccessToken.userId, userId), isNull(oauthAccessToken.revoked)));
  await revokeAllFamiliesForUser(userId, "password_changed");
}
