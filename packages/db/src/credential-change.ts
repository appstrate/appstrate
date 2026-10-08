// SPDX-License-Identifier: Apache-2.0

import { APIError } from "better-auth/api";
import { and, eq, isNull } from "drizzle-orm";
import { createLogger } from "@appstrate/core/logger";
import { db } from "./client.ts";
import { cliRefreshToken, oauthAccessToken, oauthRefreshToken } from "./schema/index.ts";

const logger = createLogger("info");

/** The part of Better Auth's internal adapter that ends sessions through its delete hooks. */
interface SessionStore {
  listSessions(userId: string): Promise<{ id: string; token: string }[]>;
  deleteSessions(sessionTokens: string[]): Promise<unknown>;
}

/**
 * Ends every way into the account other than `keepSessionId` once its
 * password has been changed or reset: the other sessions, every OAuth refresh
 * and access token, every CLI session family.
 *
 * The tokens are revoked here because ending a session does not reach them:
 * the OAuth provider spares `offline_access` refresh tokens on session end,
 * and a CLI family is bound to no session at all.
 *
 * Runs after Better Auth has written the password, which it does outside any
 * transaction. A failure is logged and fails the request: answering success
 * would tell the user the other devices are signed out when they may not be.
 */
export async function endOtherAccessAfterCredentialChange(
  sessions: SessionStore,
  userId: string,
  keepSessionId: string | null,
): Promise<void> {
  try {
    const revokedAt = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(oauthRefreshToken)
        .set({ revoked: revokedAt })
        .where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked)));
      await tx
        .update(oauthAccessToken)
        .set({ revoked: revokedAt })
        .where(and(eq(oauthAccessToken.userId, userId), isNull(oauthAccessToken.revoked)));
      await tx
        .update(cliRefreshToken)
        .set({ revokedAt, revokedReason: "password_changed" })
        .where(and(eq(cliRefreshToken.userId, userId), isNull(cliRefreshToken.revokedAt)));
    });
    // Through Better Auth rather than SQL so its session-delete hooks run
    // (the OAuth provider's back-channel logout). Not inside the transaction
    // above: Better Auth's adapter waiting on a held PGlite connection deadlocks.
    const others = (await sessions.listSessions(userId))
      .filter((s) => s.id !== keepSessionId)
      .map((s) => s.token);
    if (others.length > 0) await sessions.deleteSessions(others);
  } catch (err) {
    logger.error("auth: ending other access after a password change failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "credential_change_revocation_failed",
      code: "credential_change_revocation_failed",
    });
  }
}
