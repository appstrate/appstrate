// SPDX-License-Identifier: Apache-2.0

import { APIError } from "better-auth/api";
import { and, eq, like, or, sql } from "drizzle-orm";
import { createLogger } from "@appstrate/core/logger";
import { db } from "./client.ts";
import { verification } from "./schema/index.ts";

const logger = createLogger("info");

export const CREDENTIAL_CHANGE_REVOCATION_FAILED = "credential_change_revocation_failed";

/** The part of Better Auth's internal adapter that ends sessions through its delete hooks. */
interface SessionStore {
  listSessions(userId: string): Promise<{ id: string; token: string }[]>;
  deleteSessions(sessionTokens: string[]): Promise<unknown>;
}

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

/**
 * Ends every way into the account other than `keepSessionId` once its
 * password has been changed or reset: the other sessions, the emailed links
 * that would sign in again, then whatever the module hook revokes.
 *
 * Sessions go first, so a session about to end can no longer authorize a new
 * token or approve a device code by the time the hook runs. What it cannot
 * close is a token minted without a session in the milliseconds between the
 * two steps: an OAuth refresh rotation, or Better Auth's own `/device/token`
 * exchanging a code approved earlier.
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
    // Through Better Auth rather than SQL so its session-delete hooks run
    // (the OAuth provider's back-channel logout).
    const others = (await sessions.listSessions(userId))
      .filter((s) => s.id !== keepSessionId)
      .map((s) => s.token);
    if (others.length > 0) await sessions.deleteSessions(others);
    step = "sign_in_links";
    // The stored links that sign in: `reset-password:<token>` → user id, and
    // `magic-link:<token>` → `{"email": …}` (as typed, hence `lower`). The
    // emailed verification links are signed JWTs, with no row to delete.
    const magicLinkEmail = sql`CASE WHEN pg_input_is_valid(${verification.value}, 'jsonb')
      THEN lower(${verification.value}::jsonb ->> 'email') END`;
    await db
      .delete(verification)
      .where(
        or(
          and(like(verification.identifier, "reset-password:%"), eq(verification.value, userId)),
          and(
            like(verification.identifier, "magic-link:%"),
            eq(magicLinkEmail, account.email.toLowerCase()),
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
