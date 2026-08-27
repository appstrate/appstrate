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
import {
  loadTokens,
  saveTokens,
  _isKeyringFactoryOverriddenForTesting,
} from "../src/lib/keyring.ts";
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
    // Three shapes were tried before this one:
    //
    //  - comparing `install.store` identities across two installs, which is
    //    what this test used to do. It proves nothing: `installFakeKeyring()`
    //    allocates a fresh `Map` per call, so the stores differ whether or not
    //    `restore()` did anything. Stubbing `restore()` to an empty function
    //    left that version green while all fifteen suites calling it in
    //    `afterEach` would have leaked a live fake to whatever ran next;
    //  - reading `_keyringFactory` back and comparing it to null, which cannot
    //    work: `_setKeyringFactoryForTesting(null)` reinstalls a new closure
    //    over `new Entry(...)` rather than clearing the variable;
    //  - probing through `loadTokens` after the restore and expecting a miss.
    //    That version passed locally and SEGFAULTED CI (Bun 1.3.14, exit 132):
    //    the read reaches `@napi-rs/keyring` for real, and on a Linux runner
    //    with no keyring daemon the native call crashes the process before any
    //    JS runs. `APPSTRATE_ALLOW_PLAINTEXT_TOKENS` does not help — it gates a
    //    thrown error, and a segfault is not one. A unit test has no business
    //    touching the host's credential store at all.
    //
    // So ask `keyring.ts` directly, through the read half of the same seam.
    expect(_isKeyringFactoryOverriddenForTesting()).toBe(false);

    const install = installFakeKeyring();
    expect(_isKeyringFactoryOverriddenForTesting()).toBe(true);

    install.restore();
    expect(_isKeyringFactoryOverriddenForTesting()).toBe(false);
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

  it("leaves orgId / spaceId out of config.toml when not supplied", async () => {
    const home = useTempConfigHome("appstrate-cli-fixture-seed-");
    await home.setup();
    const keyring = installFakeKeyring();
    try {
      await seedLoggedInProfile("bare");
      // Assert on the file, not on `getProfile`: `readConfig` normalises every
      // profile to carry `orgId`/`spaceId` keys (undefined when absent),
      // so a read cannot distinguish "unpinned" from "pinned to nothing".
      const toml = await Bun.file(join(home.dir(), "appstrate", "config.toml")).text();
      expect(toml).toContain("[profile.bare]");
      expect(toml).not.toContain("orgId");
      expect(toml).not.toContain("spaceId");
    } finally {
      keyring.restore();
      await home.teardown();
    }
  });
});
