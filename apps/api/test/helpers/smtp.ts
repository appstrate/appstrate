// SPDX-License-Identifier: Apache-2.0

/**
 * Test helper that flips the Better Auth singleton into "SMTP enabled"
 * mode for the duration of a `describe` block, then restores the default
 * SMTP-off mode afterwards. This exists so regression tests for the
 * email-verification flow (signup interstitial, unverified-login resend,
 * EMAIL_NOT_VERIFIED messaging) can actually exercise BA's
 * `requireEmailVerification: true` code paths — the default preload
 * explicitly deletes the SMTP env vars so the rest of the suite stays
 * synchronous and session-happy.
 *
 * How it works:
 *   1. Inject dummy `SMTP_*` env vars with `SMTP_HOST=__test_json__`.
 *      `auth.ts` detects that sentinel and swaps in nodemailer's
 *      `jsonTransport` (no network, no hangs).
 *   2. Reset the env cache so the next `getEnv()` sees the new values.
 *   3. Call `_rebuildAuthForTesting()` so the Better Auth singleton
 *      picks up the new SMTP mode (and the new `emailVerification:
 *      { sendOnSignUp, sendOnSignIn, autoSignInAfterVerification }` block
 *      is wired into the instance).
 *   4. After the tests run, restore the original env vars and rebuild
 *      the singleton back to SMTP-off mode so unrelated tests don't see
 *      lingering state.
 *
 * Usage:
 *   import { enableSmtpForSuite } from ".../helpers/smtp.ts";
 *   describe("email verification flow", () => {
 *     enableSmtpForSuite();
 *     it("redirects to interstitial on signup", async () => { ... });
 *   });
 */

import { beforeAll, afterAll } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { _rebuildAuthForTesting } from "@appstrate/db/auth";

const SMTP_TEST_VARS = {
  SMTP_HOST: "__test_json__",
  SMTP_PORT: "587",
  SMTP_USER: "test-user",
  SMTP_PASS: "test-pass",
  SMTP_FROM: "test@appstrate.test",
} as const;

export function enableSmtpForSuite(): void {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [key, value] of Object.entries(SMTP_TEST_VARS)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    _resetCacheForTesting();
    _rebuildAuthForTesting();
  });

  afterAll(() => {
    for (const [key, original] of Object.entries(saved)) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    _resetCacheForTesting();
    _rebuildAuthForTesting();
  });
}
