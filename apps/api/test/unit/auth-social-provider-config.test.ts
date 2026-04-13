// SPDX-License-Identifier: Apache-2.0

/**
 * Unit test for the `mapProfileToUser` override on every social provider
 * we configure in `buildAuth()`. The override forces `emailVerified: true`
 * on the `userInfo` object BA's `link-account.mjs` consumes, which has two
 * effects:
 *
 *   1. The brand-new user row is inserted with `emailVerified: true`
 *      (double-safety with `shouldAutoVerifyEmailOnCreate`, which sets the
 *      same flag via the `databaseHooks.user.create.before` path).
 *   2. The `!userInfo.emailVerified` gate at `link-account.mjs:95` is
 *      bypassed, so BA does NOT send a spurious verification email right
 *      after a successful OAuth round-trip. Without this override, users
 *      whose GitHub primary email is flagged as unverified (or whose
 *      OAuth App lacks the `user:email` scope grant on a pre-existing
 *      authorization) receive a verification link moments after they
 *      finish signing in with GitHub — a UX bug that was reported and
 *      fixed on 2026-04-13.
 *
 * Why a dedicated unit test: the override is a single tiny function, but
 * losing it silently reintroduces the bug in a code path that is hard to
 * cover with integration tests (BA's social flow requires a mock OAuth2
 * provider; the suite does not have one). Testing the config shape is the
 * cheapest regression guard available.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { _rebuildAuthForTesting, getAuth } from "@appstrate/db/auth";

const SOCIAL_TEST_VARS = {
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  GITHUB_CLIENT_ID: "test-github-client-id",
  GITHUB_CLIENT_SECRET: "test-github-client-secret",
} as const;

describe("auth social provider config — emailVerified override", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [key, value] of Object.entries(SOCIAL_TEST_VARS)) {
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

  it("github provider is configured with mapProfileToUser → emailVerified: true", async () => {
    const options = (getAuth() as { options: { socialProviders?: Record<string, unknown> } })
      .options;
    const github = options.socialProviders?.github as
      | {
          mapProfileToUser?: (
            profile: unknown,
          ) => { emailVerified?: boolean } | Promise<{ emailVerified?: boolean }>;
        }
      | undefined;
    expect(github).toBeDefined();
    expect(typeof github?.mapProfileToUser).toBe("function");
    const result = await github!.mapProfileToUser!({});
    expect(result.emailVerified).toBe(true);
  });

  it("google provider is configured with mapProfileToUser → emailVerified: true", async () => {
    const options = (getAuth() as { options: { socialProviders?: Record<string, unknown> } })
      .options;
    const google = options.socialProviders?.google as
      | {
          mapProfileToUser?: (
            profile: unknown,
          ) => { emailVerified?: boolean } | Promise<{ emailVerified?: boolean }>;
        }
      | undefined;
    expect(google).toBeDefined();
    expect(typeof google?.mapProfileToUser).toBe("function");
    const result = await google!.mapProfileToUser!({});
    expect(result.emailVerified).toBe(true);
  });
});
