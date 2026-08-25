// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared auth fixture in `helpers/auth-fixture.ts`.
 *
 * The fixture replaced twelve identical `FakeKeyring` classes, each with its
 * own `static store`. The one thing a shared fixture must NOT do is turn those
 * twelve private stores into one process-wide `Map` — `bun test` runs every
 * package in a single process, so a shared store means suite A's credentials
 * are readable by suite B, with test order deciding the outcome. That is the
 * cross-suite coupling issue #1180 retired for the process streams.
 *
 * These tests are the standing proof that `installFakeKeyring()` hands out a
 * fresh store per call, and that `useTempConfigHome()` puts the env var back
 * exactly as it found it.
 */

import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadTokens, saveTokens } from "../src/lib/keyring.ts";
import { getProfile } from "../src/lib/config.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
} from "./helpers/auth-fixture.ts";

const TOKENS = {
  accessToken: "tok-isolation",
  expiresAt: Date.now() + 15 * 60 * 1000,
  refreshToken: "rt-isolation",
  refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
};

describe("installFakeKeyring", () => {
  it("gives each install its own store — no state crosses between them", async () => {
    const first = installFakeKeyring();
    await saveTokens("default", TOKENS);
    expect(first.store.size).toBe(1);

    // A second install is what a second suite in the same process does.
    const second = installFakeKeyring();
    expect(second.store.size).toBe(0);
    expect(await loadTokens("default")).toBeNull();

    await saveTokens("default", { ...TOKENS, accessToken: "tok-second" });
    expect(second.store.get("default")).toContain("tok-second");
    // The first store is untouched: distinct `Map`s, not one shared static.
    expect(first.store.get("default")).toContain("tok-isolation");
    expect(first.store).not.toBe(second.store);

    second.restore();
    first.restore();
  });

  it("restore() unwires the fake so later suites are not left holding it", () => {
    const install = installFakeKeyring();
    install.restore();
    // `saveTokens` now runs against the real `@napi-rs/keyring` again, so we
    // only assert the handle identity changed — writing here would touch the
    // developer's Keychain.
    const second = installFakeKeyring();
    expect(second.store).not.toBe(install.store);
    second.restore();
  });
});

describe("useTempConfigHome", () => {
  it("restores XDG_CONFIG_HOME to its prior value and removes the tmpdir", async () => {
    const before = process.env.XDG_CONFIG_HOME;
    const home = useTempConfigHome("appstrate-cli-fixture-");

    await home.setup();
    const dir = home.dir();
    expect(process.env.XDG_CONFIG_HOME).toBe(dir);
    expect(existsSync(dir)).toBe(true);

    await home.teardown();
    expect(process.env.XDG_CONFIG_HOME).toBe(before);
    expect(existsSync(dir)).toBe(false);
  });

  it("hands out a different directory per setup()", async () => {
    const home = useTempConfigHome("appstrate-cli-fixture-");
    await home.setup();
    const first = home.dir();
    await home.teardown();
    await home.setup();
    const second = home.dir();
    await home.teardown();
    expect(first).not.toBe(second);
  });
});

describe("seedLoggedInProfile", () => {
  it("writes profile + tokens through the production path, with overridable defaults", async () => {
    const home = useTempConfigHome("appstrate-cli-fixture-seed-");
    await home.setup();
    const keyring = installFakeKeyring();
    try {
      await seedLoggedInProfile();
      const profile = await getProfile("default");
      expect(profile).toEqual({
        instance: "https://app.example.com",
        userId: "u_1",
        email: "a@example.com",
      });
      const tokens = await loadTokens("default");
      expect(tokens?.accessToken).toBe("tok-abc");
      expect(tokens?.refreshToken).toBe("rt-xyz");

      await seedLoggedInProfile("prod", {
        email: "alice@example.com",
        orgId: "org_1",
        tokens: { accessToken: "access-1" },
      });
      expect(await getProfile("prod")).toEqual({
        instance: "https://app.example.com",
        userId: "u_1",
        email: "alice@example.com",
        orgId: "org_1",
      });
      expect((await loadTokens("prod"))?.accessToken).toBe("access-1");
    } finally {
      keyring.restore();
      await home.teardown();
    }
  });

  it("leaves orgId / applicationId out of config.toml when not supplied", async () => {
    const home = useTempConfigHome("appstrate-cli-fixture-seed-");
    await home.setup();
    const keyring = installFakeKeyring();
    try {
      await seedLoggedInProfile("bare");
      // Assert on the file, not on `getProfile`: `readConfig` normalises every
      // profile to carry `orgId`/`applicationId` keys (undefined when absent),
      // so a read cannot distinguish "unpinned" from "pinned to nothing".
      const toml = await Bun.file(join(home.dir(), "appstrate", "config.toml")).text();
      expect(toml).toContain("[profile.bare]");
      expect(toml).not.toContain("orgId");
      expect(toml).not.toContain("applicationId");
    } finally {
      keyring.restore();
      await home.teardown();
    }
  });
});
