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

/**
 * Profile name for the `restore()` probe below. Deliberately not a name any
 * real login would produce: the probe's post-restore read runs against the
 * developer's ACTUAL keyring, and must find nothing there.
 */
const PROBE_PROFILE = "appstrate-fixture-restore-probe";

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

  it("restore() unwires the fake so later suites are not left holding it", async () => {
    // Observing the unwiring means asking `keyring.ts` a question only the fake
    // can answer, and then showing it stops answering. Two shapes were tried and
    // rejected first:
    //
    //  - comparing `install.store` identities across two installs, which is what
    //    this test used to do. It proves nothing: `installFakeKeyring()`
    //    allocates a fresh `Map` on every call, so the two stores are distinct
    //    whether or not `restore()` did anything at all. Stubbing `restore()` to
    //    an empty function left that version green while all fifteen suites
    //    calling it in `afterEach` would have leaked a live fake to whatever ran
    //    next in the same `bun test` process;
    //  - reading `_keyringFactory` back from `keyring.ts`, which has no accessor
    //    for it — and adding one to production source to satisfy a test is the
    //    wrong trade when the production read path already exposes the answer.
    //
    // So probe through `loadTokens` on a profile name no real credential store
    // can carry. While the fake is wired the probe finds the seeded tokens; once
    // it is unwired the read reaches the real `@napi-rs/keyring` (no entry for
    // this profile) and then the file fallback (a temp XDG dir with no
    // `appstrate/` subtree), so it must answer null. Reads only — a WRITE after
    // `restore()` would land in the developer's Keychain, which is the reason
    // the previous shape of this test asserted on nothing.
    const home = useTempConfigHome("appstrate-cli-fixture-restore-");
    await home.setup();
    // A keyring that is installed but not serving (locked Keychain on an
    // SSH-attached macOS, frozen gnome-keyring) makes the post-restore read
    // THROW via `refuseBrokenKeyring` instead of answering null. Accepting the
    // plaintext file fallback for the duration of the probe keeps this test
    // about `restore()` rather than about the host's daemon; the temp XDG dir
    // holds no credentials file, so the fallback still answers null.
    const plaintextBefore = process.env.APPSTRATE_ALLOW_PLAINTEXT_TOKENS;
    process.env.APPSTRATE_ALLOW_PLAINTEXT_TOKENS = "1";
    const install = installFakeKeyring();
    try {
      await saveTokens(PROBE_PROFILE, TOKENS);
      expect((await loadTokens(PROBE_PROFILE))?.accessToken).toBe("tok-isolation");

      install.restore();

      // The fake no longer serves `keyring.ts`...
      expect(await loadTokens(PROBE_PROFILE)).toBeNull();
      // ...even though the store still holds the value. `restore()` unwires the
      // fake, it does not clear it — that distinction is what makes the null
      // above a statement about the wiring and not about the data.
      expect(install.store.get(PROBE_PROFILE)).toContain("tok-isolation");
    } finally {
      install.restore();
      if (plaintextBefore === undefined) delete process.env.APPSTRATE_ALLOW_PLAINTEXT_TOKENS;
      else process.env.APPSTRATE_ALLOW_PLAINTEXT_TOKENS = plaintextBefore;
      await home.teardown();
    }
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
