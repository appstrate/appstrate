// SPDX-License-Identifier: Apache-2.0

/**
 * Unit test for the social providers configured in `buildAuth()`: none of
 * them carries a `mapProfileToUser` override, so `emailVerified` is what the
 * provider itself asserts (Google's `email_verified` id_token claim, GitHub's
 * per-address `/user/emails` flag).
 *
 * Why a dedicated unit test: the suite has no mock OAuth2 provider to drive
 * Better Auth's social flow end to end, and an override forcing the flag is
 * one line that silently turns a round-trip into an assertion. Testing the
 * config shape is the cheapest regression guard available.
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

describe("auth social provider config — emailVerified comes from the provider", () => {
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

  it("github provider does NOT force emailVerified", async () => {
    // GitHub lets a user attach an UNVERIFIED email. Without an override,
    // Better Auth's per-email `/user/emails` flag is what a new row is created
    // with. It does not decide account linking: GitHub is a trusted provider,
    // and Better Auth links those without reading the flag.
    const options = (getAuth() as { options: { socialProviders?: Record<string, unknown> } })
      .options;
    const github = options.socialProviders?.github as { mapProfileToUser?: unknown } | undefined;
    expect(github).toBeDefined();
    expect(github?.mapProfileToUser).toBeUndefined();
  });

  it("google provider does NOT force emailVerified either — the id_token claim decides", async () => {
    // Better Auth maps Google's `email_verified` claim onto `emailVerified`.
    // An override answering `true` for every profile would turn "came back
    // from Google" into "Google asserts this address", which is what the
    // bootstrap-owner proof relies on.
    const options = (getAuth() as { options: { socialProviders?: Record<string, unknown> } })
      .options;
    const google = options.socialProviders?.google as { mapProfileToUser?: unknown } | undefined;
    expect(google).toBeDefined();
    expect(google?.mapProfileToUser).toBeUndefined();
  });
});
