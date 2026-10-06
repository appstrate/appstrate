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

  it.each(["google", "github"])("%s carries no mapProfileToUser override", (provider) => {
    // Without one, `emailVerified` is the provider's own answer (Google's
    // `email_verified` claim, GitHub's per-address `/user/emails` flag), which
    // is what a new row is created with and what the bootstrap-owner proof reads.
    const options = (getAuth() as { options: { socialProviders?: Record<string, unknown> } })
      .options;
    const config = options.socialProviders?.[provider] as
      { mapProfileToUser?: unknown } | undefined;
    expect(config).toBeDefined();
    expect(config?.mapProfileToUser).toBeUndefined();
  });
});
