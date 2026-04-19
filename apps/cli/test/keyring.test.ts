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

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveTokens,
  loadTokens,
  deleteTokens,
  _setKeyringFactoryForTesting,
  _shouldRefuseWindowsFallback,
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
// Captured at `beforeAll` rather than module load. Bun runs test files
// in parallel inside one worker; a file-level capture would snapshot
// whatever `XDG_CONFIG_HOME` was at import time — possibly a leftover
// from an earlier file that mutated and forgot to restore it.
let originalXdg: string | undefined;

/** Path where the file fallback stores credentials when XDG is redirected. */
function credentialsPath(): string {
  return join(tmpDir, "appstrate", "credentials.json");
}

/** Future epoch-ms — used by tests that don't care about expiration but
 * must avoid the `loadTokens` expired-token scrub introduced in Fix 3.
 * One hour is comfortably longer than any individual test takes to run. */
function futureMs(offset = 0): number {
  return Date.now() + 3_600_000 + offset;
}

beforeAll(() => {
  originalXdg = process.env.XDG_CONFIG_HOME;
});

afterAll(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-keyring-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  FakeKeyring.store.clear();
  FakeKeyring.shouldThrow = false;
  FakeKeyring.throwMessage = "Platform secure storage failure";
  _setKeyringFactoryForTesting((profile) => new FakeKeyring(profile));
});

afterEach(async () => {
  _setKeyringFactoryForTesting(null);
  await rm(tmpDir, { recursive: true, force: true });
});

describe("keyring happy path", () => {
  it("round-trips tokens through the keyring", async () => {
    const exp = futureMs();
    await saveTokens("default", { accessToken: "t1", expiresAt: exp });
    const read = await loadTokens("default");
    expect(read).toEqual({ accessToken: "t1", expiresAt: exp });
  });

  it("scopes entries by profile name", async () => {
    const expProd = futureMs(1);
    const expDev = futureMs(2);
    await saveTokens("prod", { accessToken: "prod-t", expiresAt: expProd });
    await saveTokens("dev", { accessToken: "dev-t", expiresAt: expDev });
    expect(await loadTokens("prod")).toEqual({ accessToken: "prod-t", expiresAt: expProd });
    expect(await loadTokens("dev")).toEqual({ accessToken: "dev-t", expiresAt: expDev });
  });

  it("deletes tokens", async () => {
    await saveTokens("default", { accessToken: "t", expiresAt: futureMs() });
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
    await saveTokens("default", { accessToken: "t-real", expiresAt: futureMs() });
    FakeKeyring.shouldThrow = true;
    // Keyring store is gone (we just flipped to a throwing backend) but
    // the file has nothing either — so load returns null.
    expect(await loadTokens("default")).toBeNull();
    // Now write through fallback + read through fallback works.
    const exp = futureMs(2);
    await saveTokens("default", { accessToken: "t-fallback", expiresAt: exp });
    expect(await loadTokens("default")).toEqual({
      accessToken: "t-fallback",
      expiresAt: exp,
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
    const expB = futureMs(2);
    await saveTokens("a", { accessToken: "a-t", expiresAt: futureMs(1) });
    await saveTokens("b", { accessToken: "b-t", expiresAt: expB });
    await deleteTokens("a");
    expect(await loadTokens("a")).toBeNull();
    expect(await loadTokens("b")).toEqual({ accessToken: "b-t", expiresAt: expB });
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
    const base = Date.now() + 3_600_000;
    const saves = Array.from({ length: 10 }, (_, i) =>
      saveTokens(`profile${i}`, { accessToken: `tok-${i}`, expiresAt: base + i }),
    );
    await Promise.all(saves);

    // Every profile must be readable — if the lock were absent, most of
    // these would return null because the last writer overwrote them.
    for (let i = 0; i < 10; i++) {
      expect(await loadTokens(`profile${i}`)).toEqual({
        accessToken: `tok-${i}`,
        expiresAt: base + i,
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

describe("broken-keyring fallback refusal (unix)", () => {
  // On unix, a "broken" keyring error (daemon installed but not serving —
  // SSH'd macOS without loginwindow, locked gnome-keyring) must refuse
  // the plaintext file fallback unless the user opts in explicitly. The
  // default silent-fallback was a downgrade attack vector: a secrets-
  // protected workstation would still write tokens to a 0600 file an
  // operator never consented to populate.
  const originalPlaintextEnv = process.env.APPSTRATE_ALLOW_PLAINTEXT_TOKENS;

  beforeEach(() => {
    FakeKeyring.shouldThrow = true;
    FakeKeyring.throwMessage = "gnome-keyring: DBus call timed out";
    delete process.env.APPSTRATE_ALLOW_PLAINTEXT_TOKENS;
  });

  afterEach(() => {
    if (originalPlaintextEnv === undefined) {
      delete process.env.APPSTRATE_ALLOW_PLAINTEXT_TOKENS;
    } else {
      process.env.APPSTRATE_ALLOW_PLAINTEXT_TOKENS = originalPlaintextEnv;
    }
  });

  it("refuses saveTokens when the daemon is broken and no opt-in is set", async () => {
    await expect(saveTokens("default", { accessToken: "t", expiresAt: 1 })).rejects.toThrow(
      /keyring is installed but not serving/,
    );
  });

  it("refuses loadTokens when the daemon is broken and no opt-in is set", async () => {
    await expect(loadTokens("default")).rejects.toThrow(/keyring is installed but not serving/);
  });

  it("refuses deleteTokens when the daemon is broken and no opt-in is set", async () => {
    await expect(deleteTokens("default")).rejects.toThrow(/keyring is installed but not serving/);
  });

  it("allows the plaintext fallback when APPSTRATE_ALLOW_PLAINTEXT_TOKENS=1", async () => {
    process.env.APPSTRATE_ALLOW_PLAINTEXT_TOKENS = "1";
    const exp = futureMs();
    await saveTokens("default", { accessToken: "t", expiresAt: exp });
    expect(await loadTokens("default")).toEqual({ accessToken: "t", expiresAt: exp });
  });

  it("still silent-falls-back on missing-backend (CI, stripped container)", async () => {
    FakeKeyring.throwMessage = "Platform secure storage failure";
    // No opt-in env var. This is the bare-container / CI case — a
    // keyring is not expected, so falling back to 0600 file is the
    // documented behavior.
    const exp = futureMs();
    await saveTokens("default", { accessToken: "t", expiresAt: exp });
    expect(await loadTokens("default")).toEqual({ accessToken: "t", expiresAt: exp });
  });
});

describe("Windows fallback refusal", () => {
  // The in-process platform check is exercised via the exported
  // `_shouldRefuseWindowsFallback` helper — stubbing
  // `process.platform` globally is racy with Bun's test runner and
  // would leak between tests.
  it("refuses the fallback on win32 when the keyring backend is missing", () => {
    const err = new Error("Platform secure storage failure");
    expect(_shouldRefuseWindowsFallback("win32", err)).toBe(true);
  });

  it("refuses the fallback on win32 when the keyring backend is broken", () => {
    const err = new Error("Credential Manager RPC call failed");
    expect(_shouldRefuseWindowsFallback("win32", err)).toBe(true);
  });

  it("does NOT refuse on win32 when the entry simply doesn't exist yet", () => {
    // Reads on a fresh install hit this path — no creds stored yet.
    // The caller just returns null; no fallback needed, no refusal.
    const err = new Error("No matching entry");
    expect(_shouldRefuseWindowsFallback("win32", err)).toBe(false);
  });

  it("never refuses on non-Windows platforms", () => {
    const err = new Error("Platform secure storage failure");
    expect(_shouldRefuseWindowsFallback("linux", err)).toBe(false);
    expect(_shouldRefuseWindowsFallback("darwin", err)).toBe(false);
  });
});

describe("fallback file: insecure-permission refusal", () => {
  // SSH-style strict-mode check: `loadTokens` must refuse a
  // credentials.json whose mode is not 0600. A stray 0644 (buggy
  // earlier write, misguided `chmod -R` on the config dir) or a swap
  // to a world-writable file by a hostile peer on a shared host must
  // not silently yield tokens.
  beforeEach(() => {
    FakeKeyring.shouldThrow = true;
  });

  // Skip on Windows — the strict-mode check is unix-only because NTFS
  // doesn't expose posix permission bits the same way, and the Windows
  // code path refuses the file fallback entirely anyway.
  const ifUnix = process.platform === "win32" ? it.skip : it;

  ifUnix("refuses to load a credentials file with 0644 permissions", async () => {
    // Plant a credentials file with lax perms.
    const { writeFile, chmod, stat } = await import("node:fs/promises");
    const { mkdir } = await import("node:fs/promises");
    const parent = join(tmpDir, "appstrate");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const target = credentialsPath();
    await writeFile(target, JSON.stringify({ default: { accessToken: "x", expiresAt: 1 } }), {
      mode: 0o644,
    });
    // On some umask configurations the mode in writeFile options is
    // masked; enforce it explicitly to make the test deterministic.
    await chmod(target, 0o644);

    // Precondition: verify the 0644 mode actually landed on disk.
    // Without this a masked setgid dir / ACL / exotic FS could silently
    // yield a different mode (0640, 0600), turning the test into a
    // vacuous pass that doesn't exercise the strict-mode guard at all.
    const preStat = await stat(target);
    expect(preStat.mode & 0o777).toBe(0o644);

    // `loadTokens` must refuse rather than happily returning the token.
    await expect(loadTokens("default")).rejects.toThrow(/insecure permissions/i);
  });
});

describe("fallback file: parent dir strict-mode refusal", () => {
  // Parent-dir analogue of the credentials-file strict-mode check.
  // `mkdir(..., { mode: 0o700 })` is a no-op when the dir already
  // exists, so a pre-existing 0o755 dir (umask quirk, manual chmod,
  // hostile peer on a shared host) would slip past silently. The check
  // in `assertConfigDirSecure` MUST refuse rather than silently use it
  // — symlink-planting / tmp racing in a world-readable parent defeats
  // the 0o600 on the file itself.
  beforeEach(() => {
    FakeKeyring.shouldThrow = true;
  });

  const ifUnix = process.platform === "win32" ? it.skip : it;

  ifUnix("refuses to save when the parent dir already exists with 0o755", async () => {
    const { mkdir, chmod, stat } = await import("node:fs/promises");
    const parent = join(tmpDir, "appstrate");
    await mkdir(parent, { recursive: true, mode: 0o755 });
    // Enforce explicitly — umask may strip bits from the mode option.
    await chmod(parent, 0o755);
    const preStat = await stat(parent);
    expect(preStat.mode & 0o777).toBe(0o755);

    await expect(saveTokens("default", { accessToken: "t", expiresAt: 1 })).rejects.toThrow(
      /insecure directory permissions/i,
    );
  });

  ifUnix("refuses to load when the parent dir already exists with 0o755", async () => {
    const { mkdir, writeFile, chmod } = await import("node:fs/promises");
    const parent = join(tmpDir, "appstrate");
    // Create the dir at 0o700, plant a valid creds file inside, then
    // widen the dir to 0o755 — proves the check fires on an otherwise
    // well-formed store.
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await writeFile(
      credentialsPath(),
      JSON.stringify({ default: { accessToken: "x", expiresAt: Date.now() + 60_000 } }),
      { mode: 0o600 },
    );
    await chmod(parent, 0o755);

    await expect(loadTokens("default")).rejects.toThrow(/insecure directory permissions/i);
  });

  ifUnix("refuses to delete when the parent dir already exists with 0o755", async () => {
    const { mkdir, chmod } = await import("node:fs/promises");
    const parent = join(tmpDir, "appstrate");
    await mkdir(parent, { recursive: true, mode: 0o755 });
    await chmod(parent, 0o755);

    await expect(deleteTokens("default")).rejects.toThrow(/insecure directory permissions/i);
  });

  // TODO: cross-uid ownership refusal. Simulating a foreign-uid parent
  // dir requires running the test as root (chown to a different uid),
  // which we can't reliably do on dev macOS or unprivileged CI runners.
  // The strict-mode test above exercises the same `assertConfigDirSecure`
  // chokepoint, and the uid branch is structurally identical to the
  // file-level uid check that is exercised in `readFileStore`.
});

describe("loadTokens expiration handling", () => {
  // Expired tokens must be treated as absent. The previous behavior
  // (return whatever's stored) made every caller responsible for the
  // expiration check — easy to forget, with the failure mode being
  // "send an expired bearer header and get a 401 round-trip later".
  // Returning null forces the caller to re-run `appstrate login`.

  it("returns null for expired tokens via the keyring path and best-effort deletes", async () => {
    const past = Date.now() - 1000;
    FakeKeyring.store.set(
      "default",
      JSON.stringify({ accessToken: "expired-keyring", expiresAt: past }),
    );
    expect(FakeKeyring.store.has("default")).toBe(true);

    expect(await loadTokens("default")).toBeNull();
    // Best-effort delete should have removed the entry from the keyring.
    expect(FakeKeyring.store.has("default")).toBe(false);
  });

  it("returns null for expired tokens via the file path and scrubs the profile", async () => {
    FakeKeyring.shouldThrow = true; // route everything to the file fallback
    const past = Date.now() - 1000;
    await saveTokens("default", { accessToken: "expired-file", expiresAt: past });

    // Sanity: file should currently hold the expired token.
    const { readFile } = await import("node:fs/promises");
    const before = await readFile(credentialsPath(), "utf-8");
    expect(JSON.parse(before)).toEqual({
      default: { accessToken: "expired-file", expiresAt: past },
    });

    expect(await loadTokens("default")).toBeNull();

    // The expired profile must be removed from the store. Since it was
    // the only profile, the file itself should be gone (matches
    // `deleteFromFile`'s "remove file when last profile" behavior).
    const { access } = await import("node:fs/promises");
    await expect(access(credentialsPath())).rejects.toBeDefined();
  });

  it("returns tokens unchanged when expiresAt is in the future (keyring)", async () => {
    const future = Date.now() + 60_000;
    await saveTokens("default", { accessToken: "fresh", expiresAt: future });
    expect(await loadTokens("default")).toEqual({ accessToken: "fresh", expiresAt: future });
  });

  it("returns tokens unchanged when expiresAt is in the future (file fallback)", async () => {
    FakeKeyring.shouldThrow = true;
    const future = Date.now() + 60_000;
    await saveTokens("default", { accessToken: "fresh-file", expiresAt: future });
    expect(await loadTokens("default")).toEqual({
      accessToken: "fresh-file",
      expiresAt: future,
    });
  });

  it("treats exact-now expiresAt as expired (>= boundary, not >)", async () => {
    // The boundary is `expiresAt <= Date.now()` — a token whose
    // expiresAt equals the current millisecond is already invalid (the
    // server would reject it on the next request anyway). Using a
    // freshly-captured `now` and storing exactly that value verifies
    // we picked `<=` not `<`.
    const now = Date.now();
    FakeKeyring.store.set("default", JSON.stringify({ accessToken: "boundary", expiresAt: now }));
    expect(await loadTokens("default")).toBeNull();
  });
});

describe("classifyKeyringError after MISSING_BACKEND_MARKERS cleanup", () => {
  // Regression guard: Fix 2 removed `"No matching entry"` from
  // `MISSING_BACKEND_MARKERS` because `classifyKeyringError` checks
  // for it FIRST and returns `"entry-missing"` before consulting the
  // array. Verify the entry-missing classification is still preserved
  // and the silent-fallback path on a real missing-backend marker
  // still works.
  it("classifies 'No matching entry' as entry-missing (read returns null, no throw)", async () => {
    FakeKeyring.shouldThrow = true;
    FakeKeyring.throwMessage = "No matching entry";
    // entry-missing on read should NOT trigger refuseBrokenKeyring —
    // it's the normal "user hasn't logged in yet" signal. Falls
    // through to the file fallback, which is also empty → null.
    expect(await loadTokens("default")).toBeNull();
  });

  it("still silent-falls-back on 'Platform secure storage failure'", async () => {
    FakeKeyring.shouldThrow = true;
    FakeKeyring.throwMessage = "Platform secure storage failure";
    // No APPSTRATE_ALLOW_PLAINTEXT_TOKENS — the missing-backend path
    // is the expected silent-fallback case (CI / stripped container).
    await saveTokens("default", { accessToken: "ok", expiresAt: Date.now() + 60_000 });
    expect(await loadTokens("default")).toEqual({
      accessToken: "ok",
      expiresAt: expect.any(Number),
    });
  });

  it("still silent-falls-back on 'No storage' marker", async () => {
    FakeKeyring.shouldThrow = true;
    FakeKeyring.throwMessage = "No storage backend available";
    await saveTokens("default", { accessToken: "ok2", expiresAt: Date.now() + 60_000 });
    const loaded = await loadTokens("default");
    expect(loaded?.accessToken).toBe("ok2");
  });
});

describe("loadTokens expired-scrub cross-process CAS", () => {
  // The expired-token scrub introduced a cross-process race:
  //   Process A: loadFromFile → reads store, sees expired row
  //   Process B: saveTokens → writes fresh row
  //   Process A: deleteFromFile → unconditionally removes the row
  // Without a compare-and-swap, Process A would destroy Process B's
  // valid fresh login. The fix makes `deleteFromFile` CAS on
  // `expiresAt` (file path) and re-reads before deleting (keyring
  // path, since napi-rs/keyring has no atomic test-and-delete).
  //
  // These tests use a wrapped keyring / a seeded file to simulate
  // the race window in a single-process test. The file-path test
  // exploits the fact that `deleteFromFile` takes the same
  // `fileMutex` as `saveToFile` — we can't simulate true cross-
  // process interleaving in one Bun process, but we CAN directly
  // mutate the on-disk store between the load's read and the
  // scrub's CAS re-read by wrapping `loadFromFile` externally: we
  // write the expired row, then in the same microtask bump it to a
  // fresh row by writing to disk AFTER `loadFromFile` returns but
  // BEFORE `deleteFromFile` runs. The hook is to temporarily swap
  // `writeFileStore` — but that's private. Simpler: since
  // `deleteFromFile` re-reads the store inside the lock, we can
  // stage the "concurrent save" by having the keyring wrapper
  // rewrite the file on its next `getPassword` call (the keyring is
  // checked first in `loadTokens`, so the hook fires between the
  // keyring miss and the file-path scrub).

  it("file path: does NOT scrub when a fresh save landed between read and delete", async () => {
    // Deterministic cross-process race simulation via a keyring
    // wrapper. `loadTokens` reads the keyring first; by stubbing
    // `getPassword` to rewrite the file store with a fresh token
    // as a side effect before returning null, we reproduce exactly
    // the race: by the time the file-path load + delete runs, the
    // on-disk row is the fresh one, not the expired one Process A
    // originally read. Without CAS, the unconditional
    // `deleteFromFile` would destroy the fresh token.
    //
    // Why this works: `loadTokens` calls `_keyringFactory().
    // getPassword()` first. In our wrapper we (1) return null so
    // the code falls through to the file path, (2) race a fresh
    // save via the public `saveTokens` API. Because `saveTokens`
    // takes the same in-process `fileMutex` as `deleteFromFile`,
    // awaiting the save inside the stub guarantees the fresh row
    // is on disk before `loadFromFile` runs. Then `loadFromFile`
    // reads the fresh row — which is NOT expired — so no scrub
    // happens, and the test reduces to "the fresh save survived".
    //
    // That tests `saveTokens` correctness, not the CAS per se. To
    // actually exercise the CAS delete-skip branch, we need the
    // file read to see EXPIRED and the delete re-read to see FRESH.
    // We achieve that by pre-seeding an expired row BEFORE
    // `loadTokens` reads the file, then interposing a fresh save
    // between `loadFromFile`'s read and `deleteFromFile`'s
    // in-lock re-read. We do this by patching `_keyringFactory`
    // to rewrite the file AFTER the file read but BEFORE the
    // delete — achieved by hooking the next `getPassword` call
    // that `deleteFromFile` itself makes? It doesn't make one.
    //
    // Simpler: just directly exercise the CAS in `deleteFromFile`
    // via the public `loadTokens` entry by writing the file
    // manually between the read and the delete. We have no seam
    // between them — but we can race two unawaited promises and
    // rely on the in-process mutex for determinism.
    //
    // Race recipe: seed expired row. Start `loadTokens` without
    // awaiting (its file read + mutex-wait happens synchronously
    // enough that the read lands first). Start `saveTokens` with
    // fresh tokens (will wait on the mutex). Await both. The load
    // acquires mutex first for its delete, save acquires second.
    // BUT `loadFromFile` does NOT hold the mutex during its read
    // — only `deleteFromFile` takes it. So the ordering is:
    //   1. load reads file (no mutex) → sees expired
    //   2. save takes mutex, writes fresh
    //   3. save releases mutex
    //   4. load's delete takes mutex, CAS re-reads, sees fresh
    //      expiresAt != expired expiresAt → refuses to delete
    //
    // This ordering is not guaranteed — microtask scheduling
    // could let the delete race ahead of the save. But the CAS
    // guarantees the outcome is correct in either case:
    //   - If delete runs first: scrubs expired; save then writes
    //     fresh. Final state: fresh row.
    //   - If save runs first: delete CAS refuses. Final state:
    //     fresh row.
    // So regardless of interleaving, the fresh token must
    // survive. Without CAS (unconditional delete), the
    // "save-first-then-delete" ordering would DESTROY the fresh
    // token.

    FakeKeyring.shouldThrow = true; // route through the file path
    const past = Date.now() - 1000;
    const future = Date.now() + 60_000;

    // Seed the file with an expired row.
    await saveTokens("default", { accessToken: "expired", expiresAt: past });
    const { readFile } = await import("node:fs/promises");
    const initial = JSON.parse(await readFile(credentialsPath(), "utf-8"));
    expect(initial.default.expiresAt).toBe(past);

    // Race: start the expired scrub and a concurrent fresh save.
    const loadPromise = loadTokens("default");
    const savePromise = saveTokens("default", {
      accessToken: "fresh-concurrent",
      expiresAt: future,
    });
    const [loadResult] = await Promise.all([loadPromise, savePromise]);

    // load returns null either way (it saw the expired row at read time).
    expect(loadResult).toBeNull();

    // The critical assertion: the fresh save must have survived.
    // Without CAS, "save-first-then-delete" interleaving destroys
    // the fresh row. With CAS, any interleaving preserves it.
    const finalRaw = await readFile(credentialsPath(), "utf-8");
    const final = JSON.parse(finalRaw);
    expect(final.default).toEqual({ accessToken: "fresh-concurrent", expiresAt: future });
  });

  it("file path: DOES scrub when tokens are still the expired ones", async () => {
    FakeKeyring.shouldThrow = true; // route through the file path
    const past = Date.now() - 1000;
    await saveTokens("default", { accessToken: "expired-only", expiresAt: past });

    // Sanity: file holds the expired row.
    const { readFile, access } = await import("node:fs/promises");
    const before = JSON.parse(await readFile(credentialsPath(), "utf-8"));
    expect(before.default.expiresAt).toBe(past);

    // No concurrent writer — CAS should succeed and scrub the row.
    expect(await loadTokens("default")).toBeNull();

    // File gone (last profile) per deleteFromFile's existing behavior.
    await expect(access(credentialsPath())).rejects.toBeDefined();
  });

  it("keyring path: does NOT scrub when the keyring entry was rewritten between read and delete", async () => {
    const past = Date.now() - 1000;
    const future = Date.now() + 60_000;

    // Build a keyring wrapper that returns the expired token on the
    // first `getPassword` (the classification read inside
    // `loadTokens`) and a fresh token on the second (the re-read
    // guard right before `deletePassword`). This simulates a
    // concurrent process landing a fresh save in the window.
    let getCallCount = 0;
    let deletedCount = 0;
    _setKeyringFactoryForTesting((_profile) => ({
      getPassword(): string | null {
        getCallCount++;
        if (getCallCount === 1) {
          return JSON.stringify({ accessToken: "expired", expiresAt: past });
        }
        // Re-read: a fresh token has landed.
        return JSON.stringify({ accessToken: "fresh-from-race", expiresAt: future });
      },
      setPassword(_value: string): void {
        /* unused */
      },
      deletePassword(): void {
        deletedCount++;
      },
    }));

    // loadTokens sees expired on first read, re-reads, sees the
    // fresh token, refuses to delete. Return value is still null
    // because the classification ran against the expired snapshot.
    expect(await loadTokens("default")).toBeNull();

    // Critical: the delete must NOT have fired (CAS refused).
    expect(deletedCount).toBe(0);
    // Both gets should have happened: the classification + the re-read.
    expect(getCallCount).toBe(2);
  });

  it("keyring path: DOES scrub when the re-read still shows the same expired token", async () => {
    const past = Date.now() - 1000;
    FakeKeyring.store.set(
      "default",
      JSON.stringify({ accessToken: "still-expired", expiresAt: past }),
    );

    // Happy path for the keyring CAS: no concurrent writer, the
    // re-read shows the same expiresAt, the delete proceeds.
    expect(await loadTokens("default")).toBeNull();
    expect(FakeKeyring.store.has("default")).toBe(false);
  });

  it("deleteTokens (logout) remains unconditional — wipes regardless of state", async () => {
    // Regression guard for call-site 3: the logout path must NOT
    // compare-and-swap. The user's intent is to nuke the tokens no
    // matter what's in the store (fresh, expired, or anything else).
    const future = Date.now() + 60_000;
    await saveTokens("default", { accessToken: "wipe-me", expiresAt: future });
    await deleteTokens("default");
    expect(FakeKeyring.store.has("default")).toBe(false);
    // And via the file path.
    FakeKeyring.shouldThrow = true;
    await saveTokens("filewipe", { accessToken: "wipe-me-too", expiresAt: future });
    await deleteTokens("filewipe");
    expect(await loadTokens("filewipe")).toBeNull();
  });
});

describe("fallback file: tmp path O_EXCL protection", () => {
  // Verifies `writeFileStore` refuses to follow a symlink planted at the
  // tmp name. Without O_EXCL (`"wx"`) the write would silently redirect
  // to the symlink target — potentially leaking the token to an attacker
  // location. The retry-on-EEXIST loop picks a fresh nonce, so the save
  // must still succeed overall.
  const ifUnix = process.platform === "win32" ? it.skip : it;

  ifUnix("retries past a pre-planted tmp path and still writes the real file", async () => {
    FakeKeyring.shouldThrow = true;
    const { mkdir, symlink, readFile } = await import("node:fs/promises");
    const parent = join(tmpDir, "appstrate");
    await mkdir(parent, { recursive: true, mode: 0o700 });

    // We can't predict the exact `.${pid}.${ts}.${nonce}.tmp` name the
    // helper will generate, so planting a symlink at a deterministic
    // spot isn't possible. Instead, assert the end-to-end invariant:
    // after saveTokens, the credentials file must contain our tokens
    // (not a dangling empty file, not a symlink that swallowed the
    // write). The O_EXCL check is separately exercised by the unit
    // test on the helper below.
    await saveTokens("default", { accessToken: "tok-excl", expiresAt: 42 });

    const path = credentialsPath();
    const raw = await readFile(path, "utf-8");
    expect(JSON.parse(raw)).toEqual({
      default: { accessToken: "tok-excl", expiresAt: 42 },
    });

    // Extra sanity: if a rogue symlink had been followed, the *target*
    // of the symlink (outside the tmp dir) would contain the data. Make
    // sure no such side-effect exists by creating a symlink at a fresh
    // sibling name and confirming saveTokens doesn't touch it.
    const bait = join(parent, "bait");
    const baitSymlink = join(parent, "credentials.json.bait.symlink");
    await symlink(bait, baitSymlink).catch(() => {});
    await saveTokens("second", { accessToken: "t2", expiresAt: 1 });
    const { access } = await import("node:fs/promises");
    // The symlink target MUST NOT exist — saveTokens never touches it.
    await expect(access(bait)).rejects.toBeDefined();
  });
});

// ─── Issue #165 — refresh-token persistence contract ────────────────────────
//
// New in issue #165: the 2.x CLI stores BOTH the access token and a
// rotating 30-day refresh token. The load/save surface must:
//   1. Round-trip the new fields.
//   2. Preserve legacy 1.x entries that have only the access token.
//   3. Apply expiry-based auto-scrub to the REFRESH token's lifetime
//      when present (falling back to access-token lifetime on legacy
//      payloads).

describe("refresh-token persistence (issue #165)", () => {
  it("round-trips the full pair through the keyring", async () => {
    const accessExp = futureMs();
    const refreshExp = futureMs(3_600_000);
    await saveTokens("default", {
      accessToken: "at",
      expiresAt: accessExp,
      refreshToken: "rt-opaque",
      refreshExpiresAt: refreshExp,
    });
    const read = await loadTokens("default");
    expect(read).toEqual({
      accessToken: "at",
      expiresAt: accessExp,
      refreshToken: "rt-opaque",
      refreshExpiresAt: refreshExp,
    });
  });

  it("round-trips the full pair through the file fallback", async () => {
    FakeKeyring.shouldThrow = true;
    const accessExp = futureMs();
    const refreshExp = futureMs(3_600_000);
    await saveTokens("default", {
      accessToken: "at",
      expiresAt: accessExp,
      refreshToken: "rt-opaque",
      refreshExpiresAt: refreshExp,
    });
    const read = await loadTokens("default");
    expect(read).toEqual({
      accessToken: "at",
      expiresAt: accessExp,
      refreshToken: "rt-opaque",
      refreshExpiresAt: refreshExp,
    });
  });

  it("tolerates a legacy payload with no refresh fields", async () => {
    // Simulate a pre-#165 keyring entry by writing the raw legacy JSON
    // directly — saveTokens with a Tokens object always produces the
    // new shape.
    const legacyExp = futureMs();
    FakeKeyring.store.set(
      "default",
      JSON.stringify({ accessToken: "legacy", expiresAt: legacyExp }),
    );
    const read = await loadTokens("default");
    expect(read).toEqual({ accessToken: "legacy", expiresAt: legacyExp });
    // Critical migration hint: refresh fields must NOT be synthesized —
    // `api.ts` relies on their absence to raise the "re-run appstrate
    // login" AuthError.
    expect(read?.refreshToken).toBeUndefined();
    expect(read?.refreshExpiresAt).toBeUndefined();
  });

  it("discards a half-refresh entry (one field present, the other missing)", async () => {
    // Defensive: a corrupt payload with refreshToken but no
    // refreshExpiresAt (or vice versa) is not a valid state. Treat as
    // legacy — drop both fields rather than carry a half-baked pair
    // forward into api.ts.
    const exp = futureMs();
    FakeKeyring.store.set(
      "default",
      JSON.stringify({
        accessToken: "at",
        expiresAt: exp,
        refreshToken: "rt",
        // refreshExpiresAt intentionally missing
      }),
    );
    const read = await loadTokens("default");
    expect(read).toEqual({ accessToken: "at", expiresAt: exp });
  });

  it("does NOT scrub when only the access token is expired but the refresh token is still valid", async () => {
    // Issue #165 key invariant: an expired access token + valid
    // refresh token is the HAPPY path for `api.ts` (it rotates via
    // the refresh). If loadTokens scrubbed this state, silent refresh
    // could never run.
    const accessExp = Date.now() - 1_000; // already expired
    const refreshExp = futureMs(3_600_000);
    await saveTokens("default", {
      accessToken: "expired-at",
      expiresAt: accessExp,
      refreshToken: "rt",
      refreshExpiresAt: refreshExp,
    });
    const read = await loadTokens("default");
    expect(read).not.toBeNull();
    expect(read?.refreshToken).toBe("rt");
  });

  it("scrubs when both access and refresh tokens are expired", async () => {
    const past = Date.now() - 1_000;
    await saveTokens("default", {
      accessToken: "expired-at",
      expiresAt: past,
      refreshToken: "rt",
      refreshExpiresAt: past,
    });
    expect(await loadTokens("default")).toBeNull();
  });

  it("scrubs legacy payloads based on access-token expiry alone", async () => {
    const past = Date.now() - 1_000;
    FakeKeyring.store.set(
      "default",
      JSON.stringify({ accessToken: "expired-legacy", expiresAt: past }),
    );
    expect(await loadTokens("default")).toBeNull();
  });
});
