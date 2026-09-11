// SPDX-License-Identifier: Apache-2.0

/**
 * The auth fixture every CLI command suite needs: an in-memory keyring, a
 * throw-away `XDG_CONFIG_HOME`, and a logged-in profile written through the
 * production `setProfile` / `saveTokens` path.
 *
 * Fourteen suites used to carry their own copy of all three — twelve
 * character-for-character identical `FakeKeyring` classes, fifteen copies of
 * the same `mkdtemp` + env save/restore dance, and eleven `seed…` functions
 * under six different names.
 *
 * **Why a factory and not an exported class.** The copies each had a
 * `static store = new Map()`. Hoisting that class into one module would give
 * every suite ONE `Map` for the whole `bun test` process — suite A's tokens
 * visible to suite B, decided by test order. That is precisely the cross-suite
 * coupling issue #1180 retired for the process streams, and it would be worse
 * here because credentials are what these suites assert on. `installFakeKeyring()`
 * closes over a FRESH `Map` per call, so two installs cannot see each other
 * (asserted in `test/auth-fixture.test.ts`).
 *
 * `keyring.test.ts` deliberately keeps its own fake: it tests the keyring
 * module itself and needs throw injection to exercise the file-fallback path.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _setKeyringFactoryForTesting,
  saveTokens,
  type KeyringHandle,
  type Tokens,
} from "../../src/lib/keyring.ts";
import { setProfile, type Profile } from "../../src/lib/config.ts";

export interface FakeKeyringInstall {
  /**
   * The credential store backing THIS install, keyed by profile name.
   * Exposed so a suite that installs once in `beforeAll` can still reset
   * between tests (`store.clear()`) and so assertions can read what the
   * command under test wrote.
   */
  readonly store: Map<string, string>;
  /** Restore the production keyring factory. Call from `afterEach`/`afterAll`. */
  restore(): void;
}

/**
 * Point `keyring.ts` at an in-memory store for the duration of a suite.
 *
 * Each call gets its own `Map`; nothing is shared between installs, and the
 * previous install (if any) is simply replaced — the same single-slot
 * behaviour `_setKeyringFactoryForTesting` always had.
 */
export function installFakeKeyring(): FakeKeyringInstall {
  const store = new Map<string, string>();

  _setKeyringFactoryForTesting((profile): KeyringHandle => ({
    setPassword(value: string): void {
      store.set(profile, value);
    },
    getPassword(): string | null {
      return store.get(profile) ?? null;
    },
    deletePassword(): void {
      store.delete(profile);
    },
  }));

  return {
    store,
    restore(): void {
      _setKeyringFactoryForTesting(null);
    },
  };
}

export interface TempXdgDir {
  /** Absolute path of the directory created by the last `setup()`. */
  dir(): string;
  /** Create the tmpdir and point the env var at it. */
  setup(): Promise<void>;
  /** Restore the env var to its pre-`setup()` value and remove the tmpdir. */
  teardown(): Promise<void>;
}

/**
 * `setup()`/`teardown()` must be paired (`beforeEach`/`afterEach`, or
 * `beforeAll`/`afterAll`). The original value is captured on `setup()` rather
 * than at module load: `bun test` runs every package in one process, and at
 * import time another file's fixture may still own the variable.
 */
function useTempEnvDir(envVar: string, prefix: string): TempXdgDir {
  let original: string | undefined;
  let current: string | undefined;

  return {
    dir(): string {
      if (current === undefined) throw new Error(`${envVar} fixture: setup() not called`);
      return current;
    },
    async setup(): Promise<void> {
      original = process.env[envVar];
      current = await mkdtemp(join(tmpdir(), prefix));
      process.env[envVar] = current;
    },
    async teardown(): Promise<void> {
      if (original === undefined) delete process.env[envVar];
      else process.env[envVar] = original;
      if (current !== undefined) {
        await rm(current, { recursive: true, force: true });
        current = undefined;
      }
    },
  };
}

/**
 * Redirect `XDG_CONFIG_HOME` at a per-suite tmpdir so `config.ts` and the
 * keyring file fallback resolve their paths through production code and never
 * touch the developer's real `~/.config/appstrate/`.
 */
export function useTempConfigHome(prefix: string): TempXdgDir {
  return useTempEnvDir("XDG_CONFIG_HOME", prefix);
}

/** Same, for the `XDG_CACHE_HOME` tree (the OpenAPI spec cache). */
export function useTempCacheHome(prefix: string): TempXdgDir {
  return useTempEnvDir("XDG_CACHE_HOME", prefix);
}

export interface SeedProfileOverrides extends Partial<Profile> {
  /** Token fields to override. Defaults are a fresh 15-min access + 30-day refresh. */
  tokens?: Partial<Tokens>;
}

/**
 * Write a logged-in profile + tokens the way `login` would.
 *
 * The defaults are the ones the majority of suites already asserted against,
 * so a suite with its own identity or TTLs keeps a ONE-LINE local wrapper over
 * this rather than a fourteen-line copy.
 */
export async function seedLoggedInProfile(
  profile = "default",
  overrides: SeedProfileOverrides = {},
): Promise<void> {
  const { instance, userId, email, orgId, spaceId, tokens } = overrides;

  await setProfile(profile, {
    instance: instance ?? "https://app.example.com",
    userId: userId ?? "u_1",
    email: email ?? "a@example.com",
    // Passed through even when undefined: `smol-toml` omits undefined values
    // entirely, so "no org pinned" stays literally absent from `config.toml`
    // rather than becoming an empty key the resolution cascade would see.
    orgId,
    spaceId,
  });

  const now = Date.now();
  await saveTokens(profile, {
    accessToken: "tok-abc",
    expiresAt: now + 15 * 60 * 1000,
    refreshToken: "rt-xyz",
    refreshExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
    ...tokens,
  });
}
