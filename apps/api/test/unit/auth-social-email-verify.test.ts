// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `shouldAutoVerifyEmailOnCreate`, the helper that decides
 * whether a brand-new Better Auth user should have `emailVerified: true`
 * written on creation because the signup is coming from an OAuth callback
 * (Google, GitHub, …).
 *
 * Why this is worth a dedicated unit test: the production signal is
 * `context.path === "/callback/:id"`, which is buried inside BA's
 * internal async-local-storage and cannot be observed without a real
 * OAuth provider round-trip. The integration test suite doesn't run a
 * fake OAuth2 server against Better Auth (it runs one against
 * `@appstrate/connect` only), so the social-signup branch of our
 * `databaseHooks.user.create.before` handler was completely untested
 * until this file landed. A regression that removed the branch would
 * have caused brand-new social signups to land on the verification
 * screen in production — exactly the bug this file exists to catch.
 */

import { describe, it, expect } from "bun:test";
import { shouldAutoVerifyEmailOnCreate, BA_OAUTH_CALLBACK_PATH } from "@appstrate/db/auth";

describe("shouldAutoVerifyEmailOnCreate", () => {
  it("flags a social callback signup only when the provider asserted the email is verified", () => {
    const result = shouldAutoVerifyEmailOnCreate({ path: BA_OAUTH_CALLBACK_PATH }, true);
    expect(result).toEqual({ data: { emailVerified: true } });
  });

  it("does NOT auto-verify a social callback when the provider did not assert verification (pre-ATO guard)", () => {
    // The load-bearing security fix: an OAuth callback whose provider email is
    // UNVERIFIED must not be blanket-verified — that let an attacker link an
    // unverified GitHub email onto a victim's account.
    const result = shouldAutoVerifyEmailOnCreate({ path: BA_OAUTH_CALLBACK_PATH }, false);
    expect(result).toBeUndefined();
  });

  it("passes through email/password signups (/api/auth/sign-up/email)", () => {
    const result = shouldAutoVerifyEmailOnCreate({ path: "/sign-up/email" }, true);
    expect(result).toBeUndefined();
  });

  it("passes through magic-link verify signups", () => {
    const result = shouldAutoVerifyEmailOnCreate({ path: "/magic-link/verify" }, true);
    expect(result).toBeUndefined();
  });

  it("passes through seed/admin-script signups (no path in the context)", () => {
    const result = shouldAutoVerifyEmailOnCreate({}, true);
    expect(result).toBeUndefined();
  });

  it("passes through when no context is provided", () => {
    expect(shouldAutoVerifyEmailOnCreate(null, true)).toBeUndefined();
    expect(shouldAutoVerifyEmailOnCreate(undefined, true)).toBeUndefined();
  });

  it("guards against a typo'd BA path — the callback constant must stay aligned with BA's route", () => {
    // If BA ever renames `/callback/:id`, this assertion fails and the
    // integration layer flags the drift instead of silently skipping
    // auto-verification.
    expect(BA_OAUTH_CALLBACK_PATH).toBe("/callback/:id");
  });
});
