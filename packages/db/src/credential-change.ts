// SPDX-License-Identifier: Apache-2.0

import { APIError } from "better-auth/api";
import { and, eq, isNull, like, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "./client.ts";
import { hookSlot } from "./hook-slot.ts";
import { logger } from "./logger.ts";
import { modelProviderPairings, session, verification } from "./schema/index.ts";

export const CREDENTIAL_CHANGE_REVOCATION_FAILED = "credential_change_revocation_failed";

interface SessionStore {
  deleteSessions(sessionTokens: string[]): Promise<unknown>;
}

// Better Auth runs a delete's hooks only on the rows its `findMany` returns,
// capped at 100 (`defaultFindManyLimit`); the delete itself is not capped.
const SESSION_DELETE_BATCH = 100;

/**
 * Single occupant: the OIDC module installs its half at `init()`
 * (`apps/api/src/modules/oidc/services/credential-change.ts`).
 */
export const credentialChangeHook = hookSlot<(userId: string) => Promise<void>>();

async function endOtherSessions(
  sessions: SessionStore,
  userId: string,
  keepSessionId: string | null,
): Promise<void> {
  const others = await db
    .select({ token: session.token })
    .from(session)
    .where(
      keepSessionId
        ? and(eq(session.userId, userId), ne(session.id, keepSessionId))
        : eq(session.userId, userId),
    );
  // Through Better Auth so its session-delete hooks run (back-channel logout).
  for (let i = 0; i < others.length; i += SESSION_DELETE_BATCH) {
    await sessions.deleteSessions(others.slice(i, i + SESSION_DELETE_BATCH).map((s) => s.token));
  }
}

function jsonValue(path: SQL): SQL {
  return sql`CASE WHEN pg_input_is_valid(${verification.value}, 'jsonb') THEN ${path} END`;
}

/**
 * After a password change or reset: ends the account's other sessions, its
 * stored reset links, magic links, social-link states and unredeemed pairing
 * tokens, then what the module hook revokes. Sessions go first so none can mint
 * a token while the rest runs; the last sweep ends any minted in between.
 *
 * Better Auth has already written the password: a failure fails the request,
 * since a success would claim the other devices are signed out.
 */
export async function endOtherAccessAfterCredentialChange(
  sessions: SessionStore,
  account: { id: string; email: string },
  keepSessionId: string | null,
): Promise<void> {
  const userId = account.id;
  let step = "sessions";
  try {
    await endOtherSessions(sessions, userId, keepSessionId);
    step = "sign_in_links";
    await db
      .delete(verification)
      .where(
        or(
          and(like(verification.identifier, "reset-password:%"), eq(verification.value, userId)),
          and(
            like(verification.identifier, "magic-link:%"),
            eq(
              jsonValue(sql`lower(${verification.value}::jsonb ->> 'email')`),
              account.email.toLowerCase(),
            ),
          ),
          and(
            like(verification.identifier, "auth-state:%"),
            eq(jsonValue(sql`${verification.value}::jsonb #>> '{link,userId}'`), userId),
          ),
        ),
      );
    await db
      .delete(modelProviderPairings)
      .where(
        and(eq(modelProviderPairings.userId, userId), isNull(modelProviderPairings.consumedAt)),
      );
    const moduleHook = credentialChangeHook.get();
    if (moduleHook) {
      step = "module";
      await moduleHook(userId);
    }
    step = "sessions_again";
    await endOtherSessions(sessions, userId, keepSessionId);
  } catch (err) {
    logger.error("auth: ending other access after a password change failed", {
      userId,
      step,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: CREDENTIAL_CHANGE_REVOCATION_FAILED,
      code: CREDENTIAL_CHANGE_REVOCATION_FAILED,
    });
  }
}
