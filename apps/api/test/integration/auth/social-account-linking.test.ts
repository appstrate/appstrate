// SPDX-License-Identifier: Apache-2.0

/**
 * When a Google / GitHub identity is attached to an account that already
 * exists at its address. Driven at `handleOAuthUserInfo`, the function Better
 * Auth's OAuth callback hands the provider's profile to: the suite has no
 * OAuth2 server to drive `/callback/:id` itself.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { _resetCacheForTesting } from "@appstrate/env";
import { _rebuildAuthForTesting, getAuth } from "@appstrate/db/auth";
import { account, session } from "@appstrate/db/schema";
import { createTestUser } from "../../helpers/auth.ts";
import { db, truncateAll } from "../../helpers/db.ts";

const SAVED = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
};

function setGoogle(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetCacheForTesting();
  _rebuildAuthForTesting();
}

/** The provider's answer for `email`, as the callback would pass it on. */
async function signInWithGoogle(email: string, emailVerified: boolean) {
  const context = await getAuth().$context;
  type Callback = Parameters<typeof handleOAuthUserInfo>;
  return handleOAuthUserInfo(
    { context } as unknown as Callback[0],
    {
      userInfo: { id: "google-sub-1", email, name: "From Google", emailVerified },
      account: { providerId: "google", accountId: "google-sub-1" },
    } as Callback[1],
  );
}

const linkedAccounts = (userId: string) =>
  db.select().from(account).where(eq(account.userId, userId));

describe("attaching a social identity to an existing account", () => {
  beforeAll(() => {
    setGoogle({ GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret" });
  });

  afterAll(() => {
    setGoogle(SAVED);
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it("refuses an identity whose e-mail the provider does not assert as verified", async () => {
    const existing = await createTestUser({ emailVerified: true });
    await db.delete(session).where(eq(session.userId, existing.id));

    const result = await signInWithGoogle(existing.email, false);

    expect(result.error).toBe("account not linked");
    expect((await linkedAccounts(existing.id)).map((a) => a.providerId)).toEqual(["credential"]);
    expect(await db.select().from(session).where(eq(session.userId, existing.id))).toHaveLength(0);
  });

  it("attaches an identity whose e-mail the provider asserts as verified", async () => {
    const existing = await createTestUser({ emailVerified: true });

    const result = await signInWithGoogle(existing.email, true);

    expect(result.error).toBeFalsy();
    expect((await linkedAccounts(existing.id)).map((a) => a.providerId).sort()).toEqual([
      "credential",
      "google",
    ]);
  });

  it("refuses either way when the existing account's own e-mail is unverified", async () => {
    const existing = await createTestUser({ emailVerified: false });

    expect((await signInWithGoogle(existing.email, true)).error).toBe("account not linked");
    expect((await linkedAccounts(existing.id)).map((a) => a.providerId)).toEqual(["credential"]);
  });
});
