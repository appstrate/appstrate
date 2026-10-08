// SPDX-License-Identifier: Apache-2.0

/**
 * What a password change or reset revokes among the credentials this module
 * issues. Installed at `init()` through `setCredentialChangeHook`;
 * core (`packages/db/src/credential-change.ts`) calls it once it has ended the
 * other Better Auth sessions, and owns the logging and the error answer.
 *
 * Ending a session does not reach any of what this revokes: the OAuth provider
 * spares `offline_access` refresh tokens on session end, a CLI family is bound
 * to no session, and an approved device code is exchanged without one.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { deviceCode, oauthAccessToken, oauthRefreshToken } from "@appstrate/db/schema";
import { revokeAllFamiliesForUser } from "./cli-tokens.ts";

export async function revokeOidcAccessAfterCredentialChange(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Pending and approved alike: an approved code would mint a fresh family.
    await tx.delete(deviceCode).where(eq(deviceCode.userId, userId));
    const revokedAt = new Date();
    await tx
      .update(oauthRefreshToken)
      .set({ revoked: revokedAt })
      .where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked)));
    await tx
      .update(oauthAccessToken)
      .set({ revoked: revokedAt })
      .where(and(eq(oauthAccessToken.userId, userId), isNull(oauthAccessToken.revoked)));
    await revokeAllFamiliesForUser(userId, "password_changed", tx);
  });
}
