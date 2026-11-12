// SPDX-License-Identifier: Apache-2.0

/**
 * Unit test for the social providers configured in `buildAuth()`: Google and
 * GitHub carry no `mapProfileToUser` override, so `emailVerified` is what the
 * provider itself asserts (Google's `email_verified` id_token claim, GitHub's
 * per-address `/user/emails` flag). Microsoft carries one on purpose: an
 * Entra address counts only when the tenant owns its domain (`xms_edov`).
 *
 * Why a dedicated unit test: the suite has no mock OAuth2 provider to drive
 * Better Auth's social flow end to end, and an override forcing the flag is
 * one line that silently turns a round-trip into an assertion. Testing the
 * config shape is the cheapest regression guard available.
 */

import { describe, it, expect } from "bun:test";
import type { MicrosoftEntraIDProfile, MicrosoftOptions } from "better-auth/social-providers";
import { getAuth } from "@appstrate/db/auth";
import { useAuthEnv } from "../helpers/auth-env.ts";

function socialProviderOptions(provider: string): unknown {
  return (getAuth() as { options: { socialProviders?: Record<string, unknown> } }).options
    .socialProviders?.[provider];
}

const SOCIAL_TEST_VARS = {
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  GITHUB_CLIENT_ID: "test-github-client-id",
  GITHUB_CLIENT_SECRET: "test-github-client-secret",
  MICROSOFT_CLIENT_ID: "test-microsoft-client-id",
  MICROSOFT_CLIENT_SECRET: "test-microsoft-client-secret",
} as const;

describe("auth social provider config — emailVerified comes from the provider", () => {
  useAuthEnv(SOCIAL_TEST_VARS);

  it.each(["google", "github"])("%s carries no mapProfileToUser override", (provider) => {
    // Without one, `emailVerified` is the provider's own answer (Google's
    // `email_verified` claim, GitHub's per-address `/user/emails` flag), which
    // is what a new row is created with and what the bootstrap-owner proof reads.
    const config = socialProviderOptions(provider) as { mapProfileToUser?: unknown } | undefined;
    expect(config).toBeDefined();
    expect(config?.mapProfileToUser).toBeUndefined();
  });
});

describe("auth social provider config — Microsoft", () => {
  useAuthEnv(SOCIAL_TEST_VARS);

  const profile = (claims: Partial<MicrosoftEntraIDProfile>): MicrosoftEntraIDProfile =>
    ({
      oid: "00000000-0000-0000-0000-000000000001",
      tid: "00000000-0000-0000-0000-0000000000aa",
      email: "ada@example.com",
      name: "Ada",
      ...claims,
    }) as MicrosoftEntraIDProfile;

  const mapProfile = (claims: Partial<MicrosoftEntraIDProfile>): unknown => {
    const config = socialProviderOptions("microsoft") as MicrosoftOptions;
    return config.mapProfileToUser?.(profile(claims));
  };

  it("accepts work and school accounts only by default", () => {
    expect((socialProviderOptions("microsoft") as MicrosoftOptions).tenantId).toBe("organizations");
  });

  it("keeps the address, verified, when the tenant owns its domain", () => {
    expect(mapProfile({ xms_edov: true })).toEqual({ emailVerified: true });
  });

  it.each([
    ["false", { xms_edov: false }],
    ["absent", {}],
  ])("drops the address when xms_edov is %s, so the sign-in is refused", (_label, claims) => {
    expect(mapProfile(claims)).toEqual({ email: undefined, emailVerified: false });
  });
});

describe("auth social provider config — Microsoft unset", () => {
  useAuthEnv({ MICROSOFT_CLIENT_ID: undefined, MICROSOFT_CLIENT_SECRET: undefined });

  it("is not registered without its credentials", () => {
    expect(socialProviderOptions("microsoft")).toBeUndefined();
  });
});
