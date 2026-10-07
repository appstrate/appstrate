// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `buildResolverInputs` — the credential-resolution logic
 * that chooses between the explicit `ask_…` API key path (headless CI,
 * GitHub Action) and the keyring JWT path (interactive `appstrate login`).
 *
 * Covers each branch:
 *   1. API key env var → headless path, bearerToken = ask_… value; org and
 *      space only from APPSTRATE_ORG_ID / APPSTRATE_SPACE_ID, never the profile
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

import { _buildResolverInputsForTesting, type RunCommandOptions } from "../src/commands/run.ts";
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
  APPSTRATE_SPACE_ID: process.env.APPSTRATE_SPACE_ID,
  APPSTRATE_ORG_ID: process.env.APPSTRATE_ORG_ID,
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
  delete process.env.APPSTRATE_SPACE_ID;
  delete process.env.APPSTRATE_ORG_ID;
});

afterEach(async () => {
  keyring.restore();
  await configHome.teardown();
});

function bundleOpts(over: Partial<RunCommandOptions> = {}): RunCommandOptions {
  return { bundle: "/tmp/fake.afps", ...over };
}

/** Org + space pinned: the resolver reads both off the profile. */
function seedPinnedProfile(profileName: string): Promise<void> {
  return seedLoggedInProfile(profileName, {
    orgId: "org_1",
    spaceId: "spc_1",
    tokens: {
      accessToken: "eyJhbGciOiJSUzI1NiJ9.test.jwt",
      expiresAt: Date.now() + 5 * 60 * 1000, // fresh — no refresh attempted
      refreshToken: "refresh-1",
    },
  });
}

describe("buildResolverInputs — remote", () => {
  describe("headless path (APPSTRATE_API_KEY)", () => {
    it("uses the explicit API key when paired with instance + spaceId env vars", async () => {
      process.env.APPSTRATE_API_KEY = "ask_headless_1";
      process.env.APPSTRATE_INSTANCE = "https://ci.example.com";
      process.env.APPSTRATE_SPACE_ID = "spc_ci";

      const inputs = (await _buildResolverInputsForTesting(
        "remote",
        bundleOpts(),
      )) as RemoteResolverInputs;
      expect(inputs).toEqual({
        instance: "https://ci.example.com",
        bearerToken: "ask_headless_1",
        spaceId: "spc_ci",
      });
    });

    it("takes only the instance from a profile: its org and space are not the key's", async () => {
      // The key pins its own org and space server-side; the profile's pins
      // sent as headers would be refused (403) whenever they differ.
      process.env.APPSTRATE_API_KEY = "ask_headless_2";
      await seedPinnedProfile("default");

      const inputs = (await _buildResolverInputsForTesting(
        "remote",
        bundleOpts(),
      )) as RemoteResolverInputs;
      expect(inputs).toEqual({
        instance: "https://app.example.com",
        bearerToken: "ask_headless_2",
      });
    });

    it("sends the org and space APPSTRATE_ORG_ID / APPSTRATE_SPACE_ID name", async () => {
      process.env.APPSTRATE_API_KEY = "ask_headless_4";
      process.env.APPSTRATE_SPACE_ID = "spc_ci";
      process.env.APPSTRATE_ORG_ID = "org_ci";
      await seedPinnedProfile("default");

      const inputs = (await _buildResolverInputsForTesting(
        "remote",
        bundleOpts(),
      )) as RemoteResolverInputs;
      expect(inputs).toEqual({
        instance: "https://app.example.com",
        bearerToken: "ask_headless_4",
        spaceId: "spc_ci",
        orgId: "org_ci",
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

    it("leaves the space unset when APPSTRATE_SPACE_ID names none: the key pins it", async () => {
      process.env.APPSTRATE_API_KEY = "ask_no_space";
      process.env.APPSTRATE_INSTANCE = "https://ci.example.com";

      const inputs = (await _buildResolverInputsForTesting(
        "remote",
        bundleOpts(),
      )) as RemoteResolverInputs;
      expect(inputs).toEqual({ instance: "https://ci.example.com", bearerToken: "ask_no_space" });
    });

    it("explicit --api-key flag wins over the env var", async () => {
      process.env.APPSTRATE_API_KEY = "ask_from_env";
      process.env.APPSTRATE_INSTANCE = "https://ci.example.com";
      process.env.APPSTRATE_SPACE_ID = "spc_ci";

      const inputs = (await _buildResolverInputsForTesting(
        "remote",
        bundleOpts({ apiKey: "ask_from_flag" }),
      )) as RemoteResolverInputs;
      expect(inputs.bearerToken).toBe("ask_from_flag");
    });

    it('rejects --api-key "" instead of falling back to the env key or the profile', async () => {
      process.env.APPSTRATE_API_KEY = "ask_from_env";
      await seedPinnedProfile("default");

      await expect(
        _buildResolverInputsForTesting("remote", bundleOpts({ apiKey: "" })),
      ).rejects.toMatchObject({
        name: "ResolverConfigError",
        message: "--api-key is empty",
      });
    });

    it("rejects a malformed key without echoing it", async () => {
      process.env.APPSTRATE_INSTANCE = "https://ci.example.com";
      process.env.APPSTRATE_SPACE_ID = "spc_ci";

      const err = await _buildResolverInputsForTesting(
        "remote",
        bundleOpts({ apiKey: "ask_SE\nCRET" }),
      ).catch((e: unknown) => e as Error);
      expect(err).toMatchObject({ name: "ResolverConfigError" });
      expect((err as Error).message).not.toMatch(/ask_SE|CRET/);
    });

    it("treats an empty APPSTRATE_INSTANCE / _SPACE_ID as unset", async () => {
      process.env.APPSTRATE_API_KEY = "ask_headless_3";
      process.env.APPSTRATE_INSTANCE = "";
      process.env.APPSTRATE_SPACE_ID = "";
      await seedPinnedProfile("default");

      const inputs = (await _buildResolverInputsForTesting(
        "remote",
        bundleOpts(),
      )) as RemoteResolverInputs;
      expect(inputs.instance).toBe("https://app.example.com");
      expect(inputs.spaceId).toBeUndefined();
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
        spaceId: "spc_1",
        orgId: "org_1",
      });
    });

    it("points to `appstrate login` when no profile and no API key is available", async () => {
      await expect(_buildResolverInputsForTesting("remote", bundleOpts())).rejects.toMatchObject({
        name: "ResolverConfigError",
        message: expect.stringMatching(/logged-in profile or an API key/),
      });
    });

    it("demands `appstrate space switch` when the profile has no pinned space", async () => {
      await seedLoggedInProfile("default", {
        orgId: "org_1", // no spaceId — that is the point of this test
        tokens: {
          accessToken: "eyJhbGciOiJSUzI1NiJ9.test.jwt",
          expiresAt: Date.now() + 5 * 60 * 1000,
          refreshToken: "refresh-1",
        },
      });

      await expect(_buildResolverInputsForTesting("remote", bundleOpts())).rejects.toMatchObject({
        name: "ResolverConfigError",
        message: expect.stringMatching(/no space pinned/),
      });
    });
  });
});
