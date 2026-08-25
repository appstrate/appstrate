// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `buildResolverInputs` — the credential-resolution logic
 * that chooses between the explicit `ask_…` API key path (headless CI,
 * GitHub Action) and the keyring JWT path (interactive `appstrate login`).
 *
 * Covers each branch:
 *   1. API key env var → headless path, bearerToken = ask_… value
 *   2. No env, logged-in profile → JWT pulled from the FakeKeyring
 *   3. No env, no profile → `ResolverConfigError` with actionable hint
 *
 * Isolation recipe mirrors `api-command.test.ts`:
 *   - `XDG_CONFIG_HOME` points at a per-test tmpdir so `setProfile`
 *     writes a clean config.toml.
 *   - `_setKeyringFactoryForTesting` installs `FakeKeyring` so
 *     `loadTokens` resolves without touching the OS keychain.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";

import {
  _buildResolverInputsForTesting,
  ResolverConfigError,
  type RunCommandOptions,
} from "../src/commands/run.ts";
import type { RemoteResolverInputs } from "../src/commands/run/resolver.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";

const configHome = useTempConfigHome("appstrate-cli-resolver-");
let keyring: FakeKeyringInstall;
const originalEnv = {
  APPSTRATE_API_KEY: process.env.APPSTRATE_API_KEY,
  APPSTRATE_INSTANCE: process.env.APPSTRATE_INSTANCE,
  APPSTRATE_APP_ID: process.env.APPSTRATE_APP_ID,
};

afterAll(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  delete process.env.APPSTRATE_API_KEY;
  delete process.env.APPSTRATE_INSTANCE;
  delete process.env.APPSTRATE_APP_ID;
});

afterEach(async () => {
  keyring.restore();
  await configHome.teardown();
});

function bundleOpts(over: Partial<RunCommandOptions> = {}): RunCommandOptions {
  return { bundle: "/tmp/fake.afps", ...over };
}

/** Org + application pinned: the resolver reads both off the profile. */
function seedPinnedProfile(profileName: string): Promise<void> {
  return seedLoggedInProfile(profileName, {
    orgId: "org_1",
    applicationId: "app_1",
    tokens: {
      accessToken: "eyJhbGciOiJSUzI1NiJ9.test.jwt",
      expiresAt: Date.now() + 5 * 60 * 1000, // fresh — no refresh attempted
      refreshToken: "refresh-1",
    },
  });
}

describe("buildResolverInputs — remote", () => {
  describe("headless path (APPSTRATE_API_KEY)", () => {
    it("uses the explicit API key when paired with instance + applicationId env vars", async () => {
      process.env.APPSTRATE_API_KEY = "ask_headless_1";
      process.env.APPSTRATE_INSTANCE = "https://ci.example.com";
      process.env.APPSTRATE_APP_ID = "app_ci";

      const inputs = (await _buildResolverInputsForTesting(
        "remote",
        bundleOpts(),
      )) as RemoteResolverInputs;
      expect(inputs).toEqual({
        instance: "https://ci.example.com",
        bearerToken: "ask_headless_1",
        applicationId: "app_ci",
      });
    });

    it("falls back to the profile for instance + applicationId when env vars are unset", async () => {
      process.env.APPSTRATE_API_KEY = "ask_headless_2";
      await seedPinnedProfile("default");

      const inputs = (await _buildResolverInputsForTesting(
        "remote",
        bundleOpts(),
      )) as RemoteResolverInputs;
      expect(inputs).toEqual({
        instance: "https://app.example.com",
        bearerToken: "ask_headless_2",
        applicationId: "app_1",
        orgId: "org_1",
      });
    });

    it("throws a hint-bearing ResolverConfigError when instance cannot be resolved", async () => {
      process.env.APPSTRATE_API_KEY = "ask_no_instance";
      // No profile, no APPSTRATE_INSTANCE → unresolvable.
      await expect(_buildResolverInputsForTesting("remote", bundleOpts())).rejects.toMatchObject({
        name: "ResolverConfigError",
        message: expect.stringMatching(/No Appstrate instance URL/),
      });
    });

    it("throws a hint-bearing ResolverConfigError when applicationId cannot be resolved", async () => {
      process.env.APPSTRATE_API_KEY = "ask_no_app";
      process.env.APPSTRATE_INSTANCE = "https://ci.example.com";
      // No profile, no APPSTRATE_APP_ID → unresolvable.
      await expect(_buildResolverInputsForTesting("remote", bundleOpts())).rejects.toMatchObject({
        name: "ResolverConfigError",
        message: expect.stringMatching(/No application id pinned/),
      });
    });

    it("explicit --api-key flag wins over the env var", async () => {
      process.env.APPSTRATE_API_KEY = "ask_from_env";
      process.env.APPSTRATE_INSTANCE = "https://ci.example.com";
      process.env.APPSTRATE_APP_ID = "app_ci";

      const inputs = (await _buildResolverInputsForTesting(
        "remote",
        bundleOpts({ apiKey: "ask_from_flag" }),
      )) as RemoteResolverInputs;
      expect(inputs.bearerToken).toBe("ask_from_flag");
    });
  });

  describe("interactive path (keyring JWT)", () => {
    it("pulls the JWT access token from the logged-in profile when no API key is set", async () => {
      await seedPinnedProfile("default");

      const inputs = (await _buildResolverInputsForTesting(
        "remote",
        bundleOpts(),
      )) as RemoteResolverInputs;
      expect(inputs).toEqual({
        instance: "https://app.example.com",
        bearerToken: "eyJhbGciOiJSUzI1NiJ9.test.jwt",
        applicationId: "app_1",
        orgId: "org_1",
      });
    });

    it("points to `appstrate login` when no profile and no API key is available", async () => {
      await expect(_buildResolverInputsForTesting("remote", bundleOpts())).rejects.toMatchObject({
        name: "ResolverConfigError",
        message: expect.stringMatching(/logged-in profile or an API key/),
      });
    });

    it("demands `appstrate app switch` when the profile has no pinned application", async () => {
      await seedLoggedInProfile("default", {
        orgId: "org_1", // no applicationId — that is the point of this test
        tokens: {
          accessToken: "eyJhbGciOiJSUzI1NiJ9.test.jwt",
          expiresAt: Date.now() + 5 * 60 * 1000,
          refreshToken: "refresh-1",
        },
      });

      await expect(_buildResolverInputsForTesting("remote", bundleOpts())).rejects.toMatchObject({
        name: "ResolverConfigError",
        message: expect.stringMatching(/no application pinned/),
      });
    });
  });

  it("uses ResolverConfigError as its error class so the CLI formatError pipeline renders hints", async () => {
    await expect(_buildResolverInputsForTesting("remote", bundleOpts())).rejects.toBeInstanceOf(
      ResolverConfigError,
    );
  });
});
