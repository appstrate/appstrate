// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/keyring.ts`.
 *
 * The real OS keyring is unreliable to exercise deterministically on CI
 * (Keychain may prompt on macOS, libsecret may be absent on Linux). We
 * swap the `@napi-rs/keyring` Entry factory via
 * `_setKeyringFactoryForTesting` to cover both the happy path and the
 * fallback-to-file path with a plain in-memory map.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveTokens,
  loadTokens,
  deleteTokens,
  _setKeyringFactoryForTesting,
  type KeyringHandle,
} from "../src/lib/keyring.ts";

// In-memory keyring backend + a toggle to simulate a failing daemon.
// `throwMessage` defaults to the napi-rs/keyring error surfaced when no
// backend is available — the expected silent-fallback path.
class FakeKeyring implements KeyringHandle {
  static store = new Map<string, string>();
  static shouldThrow = false;
  static throwMessage = "Platform secure storage failure";

  constructor(private profile: string) {}

  setPassword(value: string): void {
    if (FakeKeyring.shouldThrow) throw new Error(FakeKeyring.throwMessage);
    FakeKeyring.store.set(this.profile, value);
  }

  getPassword(): string | null {
    if (FakeKeyring.shouldThrow) throw new Error(FakeKeyring.throwMessage);
    return FakeKeyring.store.get(this.profile) ?? null;
  }

  deletePassword(): void {
    if (FakeKeyring.shouldThrow) throw new Error(FakeKeyring.throwMessage);
    FakeKeyring.store.delete(this.profile);
  }
}

let tmpDir: string;
const originalXdg = process.env.XDG_CONFIG_HOME;

/** Path where the file fallback stores credentials when XDG is redirected. */
function credentialsPath(): string {
  return join(tmpDir, "appstrate", "credentials.json");
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-keyring-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  FakeKeyring.store.clear();
  FakeKeyring.shouldThrow = false;
  FakeKeyring.throwMessage = "Platform secure storage failure";
  _setKeyringFactoryForTesting((profile) => new FakeKeyring(profile));
});

afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  _setKeyringFactoryForTesting(null);
  await rm(tmpDir, { recursive: true, force: true });
});

describe("keyring happy path", () => {
  it("round-trips tokens through the keyring", async () => {
    await saveTokens("default", { accessToken: "t1", expiresAt: 123456 });
    const read = await loadTokens("default");
    expect(read).toEqual({ accessToken: "t1", expiresAt: 123456 });
  });

  it("scopes entries by profile name", async () => {
    await saveTokens("prod", { accessToken: "prod-t", expiresAt: 1 });
    await saveTokens("dev", { accessToken: "dev-t", expiresAt: 2 });
    expect(await loadTokens("prod")).toEqual({ accessToken: "prod-t", expiresAt: 1 });
    expect(await loadTokens("dev")).toEqual({ accessToken: "dev-t", expiresAt: 2 });
  });

  it("deletes tokens", async () => {
    await saveTokens("default", { accessToken: "t", expiresAt: 1 });
    await deleteTokens("default");
    expect(await loadTokens("default")).toBeNull();
  });

  it("returns null when the profile is absent", async () => {
    expect(await loadTokens("never-logged-in")).toBeNull();
  });
});

describe("keyring fallback path (daemon unavailable)", () => {
  it("falls back to the file when setPassword throws", async () => {
    FakeKeyring.shouldThrow = true;
    await saveTokens("default", { accessToken: "t-fallback", expiresAt: 99 });
    // File must now hold the tokens.
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(credentialsPath(), "utf-8");
    expect(JSON.parse(raw)).toEqual({
      default: { accessToken: "t-fallback", expiresAt: 99 },
    });
  });

  it("loadTokens recovers from the file when keyring throws", async () => {
    // First write via keyring (working), then flip to failing backend —
    // simulates `/tmp`-based container setups where the agent could read
    // at boot but now cannot hit the daemon.
    await saveTokens("default", { accessToken: "t-real", expiresAt: 1 });
    FakeKeyring.shouldThrow = true;
    // Keyring store is gone (we just flipped to a throwing backend) but
    // the file has nothing either — so load returns null.
    expect(await loadTokens("default")).toBeNull();
    // Now write through fallback + read through fallback works.
    await saveTokens("default", { accessToken: "t-fallback", expiresAt: 2 });
    expect(await loadTokens("default")).toEqual({
      accessToken: "t-fallback",
      expiresAt: 2,
    });
  });

  it("writes the fallback file with 0600 permissions", async () => {
    FakeKeyring.shouldThrow = true;
    await saveTokens("default", { accessToken: "t", expiresAt: 1 });
    const { stat } = await import("node:fs/promises");
    const s = await stat(credentialsPath());
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("deleteTokens removes the file when it was the last profile", async () => {
    FakeKeyring.shouldThrow = true;
    await saveTokens("only", { accessToken: "t", expiresAt: 1 });
    await deleteTokens("only");
    const { access } = await import("node:fs/promises");
    await expect(access(credentialsPath())).rejects.toBeDefined();
  });

  it("deleteTokens preserves other profiles in the fallback file", async () => {
    FakeKeyring.shouldThrow = true;
    await saveTokens("a", { accessToken: "a-t", expiresAt: 1 });
    await saveTokens("b", { accessToken: "b-t", expiresAt: 2 });
    await deleteTokens("a");
    expect(await loadTokens("a")).toBeNull();
    expect(await loadTokens("b")).toEqual({ accessToken: "b-t", expiresAt: 2 });
  });
});

describe("concurrent writes via file fallback", () => {
  beforeEach(() => {
    FakeKeyring.shouldThrow = true; // force every save onto the file path
  });

  it("serializes concurrent saves without losing profiles", async () => {
    // 10 parallel saves, each with a distinct profile name. The lock
    // must serialize the read-modify-write cycles — without it, later
    // writers clobber earlier profiles by overwriting a stale snapshot.
    const saves = Array.from({ length: 10 }, (_, i) =>
      saveTokens(`profile${i}`, { accessToken: `tok-${i}`, expiresAt: 1000 + i }),
    );
    await Promise.all(saves);

    // Every profile must be readable — if the lock were absent, most of
    // these would return null because the last writer overwrote them.
    for (let i = 0; i < 10; i++) {
      expect(await loadTokens(`profile${i}`)).toEqual({
        accessToken: `tok-${i}`,
        expiresAt: 1000 + i,
      });
    }
  });

  it("writes are atomic — no torn state on mid-write crash", async () => {
    // Seed an initial valid state.
    await saveTokens("existing", { accessToken: "keep", expiresAt: 1 });

    // A crash between `writeFile(tmp)` and `rename(tmp, target)` would
    // leave `.tmp` files on disk but never a half-written target. We
    // can't actually crash Bun mid-operation in a unit test, so assert
    // the invariant that matters: after every `saveTokens`, the target
    // file parses cleanly as JSON with every previously-written profile
    // intact.
    for (let i = 0; i < 5; i++) {
      await saveTokens(`p${i}`, { accessToken: `t${i}`, expiresAt: i });
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(credentialsPath(), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, { accessToken: string }>;
      expect(parsed.existing?.accessToken).toBe("keep");
      for (let j = 0; j <= i; j++) {
        expect(parsed[`p${j}`]?.accessToken).toBe(`t${j}`);
      }
    }
  });
});

describe("corrupt data handling", () => {
  it("returns null for malformed keyring payloads instead of crashing", async () => {
    // Simulate a foreign tool writing junk under our service key.
    FakeKeyring.store.set("default", "not json at all");
    expect(await loadTokens("default")).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    FakeKeyring.store.set("default", JSON.stringify({ accessToken: "t" }));
    expect(await loadTokens("default")).toBeNull();
  });
});
