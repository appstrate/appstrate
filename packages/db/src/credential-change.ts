// SPDX-License-Identifier: Apache-2.0

import { APIError } from "better-auth/api";
import { and, eq, like, ne, or, sql, type SQL } from "drizzle-orm";
import { createLogger } from "@appstrate/core/logger";
import { db } from "./client.ts";
import { session, verification } from "./schema/index.ts";

const logger = createLogger("info");

export const CREDENTIAL_CHANGE_REVOCATION_FAILED = "credential_change_revocation_failed";

/** The part of Better Auth's internal adapter that ends sessions through its delete hooks. */
interface SessionStore {
  deleteSessions(sessionTokens: string[]): Promise<unknown>;
}

/**
 * Better Auth runs a delete's hooks only on the rows a `findMany` returns, which
 * its adapter caps at 100 (`defaultFindManyLimit`), while the delete itself is
 * uncapped: past 100 sessions in one call, the rest would end without hooks.
 */
const SESSION_DELETE_BATCH = 100;

// ─── Module half (injected at boot by the OIDC module) ───
//
// Core ends what it owns; the credentials a module issues are revoked by the
// hook it installs here: the OIDC module's OAuth tokens, CLI session families
// and device codes (`apps/api/src/modules/oidc/services/credential-change.ts`).

type CredentialChangeHook = (userId: string) => Promise<void>;

let _credentialChangeHook: CredentialChangeHook | null = null;

export function setCredentialChangeHook(hook: CredentialChangeHook): void {
  _credentialChangeHook = hook;
}

/** Test-only: swap the hook (null = no OIDC module) and return the previous one. */
export function _swapCredentialChangeHookForTesting(
  hook: CredentialChangeHook | null,
): CredentialChangeHook | null {
  const previous = _credentialChangeHook;
  _credentialChangeHook = hook;
  return previous;
}

/** A `verification` value read as JSON, or NULL when the row's value is not JSON. */
function jsonValue(path: SQL): SQL {
  return sql`CASE WHEN pg_input_is_valid(${verification.value}, 'jsonb') THEN ${path} END`;
}

/**
 * Once a password has been changed or reset: ends the account's sessions other
 * than `keepSessionId`, deletes the stored links that would sign in or attach a
 * sign-in method (reset links, magic links, social-link states), then runs the
 * module hook. Signed emailed links and linked accounts are left as they are.
 *
 * Sessions go first, so a session about to end can no longer authorize a new
 * token or approve a device code by the time the hook runs. What this order
 * cannot close is a token minted without a session while the hook runs: an
 * OAuth refresh rotation whose new row lands after the hook's UPDATE, or Better
 * Auth's own `/device/token` exchanging a code approved earlier. A CLI rotation
 * in that window revokes itself (sibling check in `cli-tokens.ts`).
 *
 * Runs after Better Auth has written the password, which it does outside any
 * transaction. A failure is logged and fails the request: answering success
 * would tell the user the other devices are signed out when they may not be.
 */
export async function endOtherAccessAfterCredentialChange(
  sessions: SessionStore,
  account: { id: string; email: string },
  keepSessionId: string | null,
): Promise<void> {
  const userId = account.id;
  let step = "sessions";
  try {
    const others = await db
      .select({ token: session.token })
      .from(session)
      .where(
        keepSessionId
          ? and(eq(session.userId, userId), ne(session.id, keepSessionId))
          : eq(session.userId, userId),
      );
    // Through Better Auth rather than SQL so its session-delete hooks run
    // (the OAuth provider's back-channel logout).
    for (let i = 0; i < others.length; i += SESSION_DELETE_BATCH) {
      const batch = others.slice(i, i + SESSION_DELETE_BATCH).map((s) => s.token);
      await sessions.deleteSessions(batch);
    }
    step = "sign_in_links";
    // `reset-password:<token>` → user id; `magic-link:<token>` → `{"email": …}`
    // as typed, hence `lower`; `auth-state:<state>` → `{"link": {"userId": …}}`
    // for a social account being linked from a session.
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
    if (_credentialChangeHook) {
      step = "module";
      await _credentialChangeHook(userId);
    }
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
