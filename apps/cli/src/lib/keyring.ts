// SPDX-License-Identifier: Apache-2.0

/**
 * Token storage for the CLI.
 *
 * Primary path: OS keyring via `@napi-rs/keyring` (Keychain on macOS,
 * libsecret/DBus on Linux, Credential Manager on Windows). Fallback:
 * `$XDG_CONFIG_HOME/appstrate/credentials.json` with `0600` permissions
 * when no keyring daemon is available (CI runners, stripped containers
 * — confirmed during preflight PF-1 where `@napi-rs/keyring` threw
 * `Platform secure storage failure` on a bare Debian slim image).
 *
 * Tokens are scoped by profile: the keyring entry key is
 * `(appstrate, <profile>)` so profiles share the service name.
 *
 * We do NOT store a refresh token. Better Auth's `deviceAuthorization()`
 * plugin returns a session token (not a JWT) whose lifetime is the
 * session lifetime (7 days by default on Appstrate). When it expires,
 * the user re-runs `appstrate login`. Documented in
 * `docs/specs/cli-preflight-results.md` § Residual caveats accepted for
 * v0.
 */

import { Entry } from "@napi-rs/keyring";
import { join, dirname } from "node:path";
import { readFile, unlink, mkdir, stat } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import { Mutex } from "async-mutex";
import { getConfigDir } from "./config.ts";

/**
 * Opt-in escape hatch for environments where the keyring daemon is
 * present but refuses to serve (SSH-attached macOS without a logged-in
 * loginwindow, frozen gnome-keyring, stripped container with a stale
 * libsecret socket). Without this env var set, a `"broken"` keyring
 * error is fatal instead of silently writing plaintext tokens to the
 * file fallback. The rationale is symmetric with the Windows refusal:
 * if the user's machine is configured to protect secrets via the OS
 * keyring, a broken backend is a signal, not a reason to quietly
 * downgrade.
 */
function plaintextFallbackAllowed(): boolean {
  return process.env.APPSTRATE_ALLOW_PLAINTEXT_TOKENS === "1";
}

export interface Tokens {
  /** BA session token — sent as `Cookie: better-auth.session_token=<value>`. */
  accessToken: string;
  /** Epoch-ms at which the token expires. */
  expiresAt: number;
}

export interface KeyringHandle {
  setPassword(value: string): void;
  getPassword(): string | null;
  deletePassword(): void;
}

type KeyringFactory = (profile: string) => KeyringHandle;

const SERVICE_NAME = "appstrate";

// Default factory wraps the real napi-rs Entry. Tests can swap this via
// `_setKeyringFactoryForTesting()` to exercise the fallback path on
// hosts that happen to have a working keyring daemon.
let _keyringFactory: KeyringFactory = (profile) => new Entry(SERVICE_NAME, profile);

export function _setKeyringFactoryForTesting(factory: KeyringFactory | null): void {
  _keyringFactory = factory ?? ((profile) => new Entry(SERVICE_NAME, profile));
}

function fallbackPath(): string {
  return join(getConfigDir(), "credentials.json");
}

/**
 * Known substrings thrown by `@napi-rs/keyring` on hosts where no
 * keyring daemon is available. These are expected fallback triggers —
 * silently route to the file store. Anything else is surfaced as a
 * one-time stderr warning so a broken daemon (corrupt libsecret,
 * locked keychain) doesn't degrade into silent plaintext storage
 * without any signal to the operator.
 *
 * The wording comes from the napi-rs/keyring error constructors we
 * observed during preflight PF-1 (Debian slim without libsecret,
 * stripped CI image). If this list drifts out of sync with upstream
 * the only cost is an extra warning line — never a wrong outcome.
 *
 * Note: `"No matching entry"` is intentionally NOT in this list.
 * `classifyKeyringError` checks for it FIRST and returns
 * `"entry-missing"` before this array is consulted, so including it
 * here would be unreachable dead code. Entry-missing is a read-path
 * concept (the user simply hasn't logged in yet), distinct from the
 * "no keyring daemon at all" fallback signal this list represents.
 */
const MISSING_BACKEND_MARKERS = ["Platform secure storage failure", "No storage"];

/** De-dupe stderr output across calls within the same process. */
let _backendWarningEmitted = false;

function classifyKeyringError(err: unknown): "missing-backend" | "entry-missing" | "broken" {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("No matching entry")) return "entry-missing";
  if (MISSING_BACKEND_MARKERS.some((marker) => msg.includes(marker))) return "missing-backend";
  return "broken";
}

/**
 * On Windows, refuse the file fallback entirely: NTFS ACLs do NOT
 * enforce Unix 0600 permissions, so `fs.chmod(0o600)` is a no-op. A
 * plaintext credentials file dropped under `%APPDATA%\appstrate\` is
 * readable by every local user on the machine — bearer token = full
 * account takeover. Credential Manager is the only acceptable store on
 * Windows; if it's down, we fail loudly rather than silently fall back
 * to disk. DPAPI-based encryption would fix this but is out of scope
 * for v1 (tracked as a follow-up in ADR-006).
 *
 * `entry-missing` is a read-path concept ("user hasn't logged in yet")
 * and never triggers a fallback, so we don't refuse on that case.
 * Export kept under the `_`-prefix convention for unit testability —
 * the real `process.platform` can't be faked cleanly in bun:test.
 */
export function _shouldRefuseWindowsFallback(platform: string, err: unknown): boolean {
  if (platform !== "win32") return false;
  return classifyKeyringError(err) !== "entry-missing";
}

function refuseWindowsFallback(op: "read" | "write" | "delete", err: unknown): never {
  const cause = err instanceof Error ? err.message : String(err);
  throw new Error(
    `Cannot ${op} Appstrate credentials: Windows Credential Manager is unavailable.\n` +
      `  Cause: ${cause}\n` +
      `  The file fallback is disabled on Windows because NTFS ACLs do not\n` +
      `  enforce Unix 0600 permissions — a plaintext credentials.json would\n` +
      `  be readable by every local user on this machine.\n\n` +
      `  Fixes:\n` +
      `    • Ensure the "Credential Manager" service is running\n` +
      `      (services.msc → CredentialManager → Start).\n` +
      `    • Or run the CLI inside WSL, where libsecret handles storage.`,
  );
}

/**
 * Refuse the plaintext file fallback on unix hosts where the keyring
 * daemon is installed but broken (locked Keychain on headless SSH, a
 * gnome-keyring that can't unlock, etc.). Returns instead of throwing
 * so callers can still layer their own context (op name), but always
 * ends by throwing. Silent plaintext-on-disk is the worst failure mode
 * — a bearer token in `~/.config/appstrate/credentials.json` equals
 * full account takeover for anyone with read access to the file.
 */
function refuseBrokenKeyring(op: "read" | "write" | "delete", err: unknown): never {
  const cause = err instanceof Error ? err.message : String(err);
  throw new Error(
    `Cannot ${op} Appstrate credentials: the OS keyring is installed but not serving.\n` +
      `  Cause: ${cause}\n` +
      `  Refusing to fall back to the plaintext file store because your\n` +
      `  machine is configured to protect secrets via the keyring — a\n` +
      `  plaintext credentials.json would be a silent downgrade.\n\n` +
      `  Fixes (pick one):\n` +
      `    • macOS: run the CLI from a Terminal attached to a logged-in\n` +
      `      GUI session (Keychain needs loginwindow). Under SSH, run\n` +
      `      \`security unlock-keychain\` first or re-attach via tmux from\n` +
      `      a GUI terminal.\n` +
      `    • Linux: ensure gnome-keyring / kwallet is running and unlocked\n` +
      `      (check with \`secret-tool store …\`).\n` +
      `    • Explicitly accept plaintext storage with:\n` +
      `        APPSTRATE_ALLOW_PLAINTEXT_TOKENS=1 appstrate ${op === "delete" ? "logout" : "login"}\n` +
      `      Only do this if you understand the tokens will be written\n` +
      `      to ~/.config/appstrate/credentials.json (mode 0600).`,
  );
}

function warnBackendOnce(op: "read" | "write" | "delete", err: unknown): void {
  if (_backendWarningEmitted) return;
  _backendWarningEmitted = true;
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `[appstrate] OS keyring ${op} failed (${msg}) — falling back to ~/.config/appstrate/credentials.json (0600). ` +
      `If this was unexpected, fix the keyring backend to restore secure storage.\n`,
  );
}

export async function saveTokens(profile: string, tokens: Tokens): Promise<void> {
  const payload = JSON.stringify(tokens);
  try {
    _keyringFactory(profile).setPassword(payload);
    return;
  } catch (err) {
    if (_shouldRefuseWindowsFallback(process.platform, err)) refuseWindowsFallback("write", err);
    // Three classes of error on write:
    //   - `missing-backend`: no keyring daemon on this host (bare CI,
    //     stripped container). Legitimate silent fallback to the 0600
    //     JSON file — that's the whole point of the fallback.
    //   - `broken`: keyring installed but not serving (locked Keychain,
    //     frozen gnome-keyring). Refused by default. `APPSTRATE_ALLOW_
    //     PLAINTEXT_TOKENS=1` opts in.
    //   - `entry-missing`: napi-rs's "No matching entry" wording, which
    //     is a read-path concept that shouldn't surface on a write.
    //     Treat it symmetrically with `broken` — refuse by default,
    //     because if the classification is wrong we'd rather fail loud
    //     than silently drop plaintext tokens on disk. The same
    //     `APPSTRATE_ALLOW_PLAINTEXT_TOKENS=1` escape hatch covers the
    //     corner case where a future napi-rs version legitimately uses
    //     that wording on write.
    const kind = classifyKeyringError(err);
    if (kind === "broken" || kind === "entry-missing") {
      if (!plaintextFallbackAllowed()) refuseBrokenKeyring("write", err);
      warnBackendOnce("write", err);
    }
  }
  await saveToFile(profile, tokens);
}

/**
 * Expired tokens are treated as absent to prevent stale credentials
 * from being presented as bearer headers — the caller must re-run
 * `appstrate login`. We don't apply a grace window: the consumer is
 * the bearer-auth header and the server will reject an expired token
 * regardless, so any clock-skew tolerance just delays the inevitable
 * re-auth while widening the window in which a leaked-but-expired
 * token could be replayed.
 */
function isExpired(tokens: Tokens): boolean {
  return tokens.expiresAt <= Date.now();
}

export async function loadTokens(profile: string): Promise<Tokens | null> {
  try {
    const raw = _keyringFactory(profile).getPassword();
    if (typeof raw === "string" && raw.length > 0) {
      const parsed = parseTokens(raw);
      if (parsed && isExpired(parsed)) {
        // Best-effort cleanup — if the keyring delete throws (broken
        // daemon, race with another process), swallow it: the value
        // we're returning to the caller (null) is correct regardless,
        // and surfacing a delete error here would mask the real
        // signal ("you need to log in again").
        //
        // Cross-process race mitigation: re-read the keyring entry
        // right before deleting and only proceed if the expiresAt
        // still matches what we just classified as expired. If a
        // concurrent `saveTokens` from another process bumped the row
        // to a fresh token in the gap, leave it alone — the
        // unconditional delete would destroy a valid fresh login. The
        // napi-rs/keyring API doesn't expose an atomic test-and-delete
        // primitive, so this is the closest we get; if the re-read
        // itself throws, skip the delete (prefer a stale entry over
        // destroying a fresh one).
        let safeToDelete = false;
        try {
          const reread = _keyringFactory(profile).getPassword();
          const rereadTokens = typeof reread === "string" ? parseTokens(reread) : null;
          if (!rereadTokens || rereadTokens.expiresAt === parsed.expiresAt) {
            safeToDelete = true;
          }
        } catch {
          /* re-read failed: leave the entry alone */
        }
        if (safeToDelete) {
          try {
            _keyringFactory(profile).deletePassword();
          } catch {
            /* best-effort */
          }
        }
        return null;
      }
      return parsed;
    }
  } catch (err) {
    if (_shouldRefuseWindowsFallback(process.platform, err)) refuseWindowsFallback("read", err);
    // "No matching entry" on read is normal — the user simply hasn't
    // stored credentials for this profile yet. Missing-backend is the
    // expected fallback trigger. A broken daemon is refused on unix
    // unless the user opts into plaintext explicitly, otherwise we'd
    // silently read from a plaintext file the user never consented to
    // populate.
    const kind = classifyKeyringError(err);
    if (kind === "broken") {
      if (!plaintextFallbackAllowed()) refuseBrokenKeyring("read", err);
      warnBackendOnce("read", err);
    }
  }
  // Windows never reaches here: the guard above either succeeded on
  // Credential Manager or threw via `refuseWindowsFallback`.
  if (process.platform === "win32") return null;
  const fromFile = await loadFromFile(profile);
  if (fromFile && isExpired(fromFile)) {
    // Proactively scrub the expired entry from the file store. Same
    // rationale as the keyring branch — the caller sees `null` and
    // re-runs login; we just don't want a stale plaintext token
    // sitting on disk indefinitely after it stopped being usable.
    //
    // Compare-and-swap on `expiresAt`: a concurrent `saveTokens` from
    // another process may have bumped the row to a fresh token in the
    // window between our read and the delete. Without the CAS, the
    // unconditional delete would destroy a valid fresh login the user
    // would then have to redo — a regression from the pre-scrub
    // behavior where that concurrent save would simply have won via
    // last-write-wins (see top-of-section doc on benign races).
    await deleteFromFile(profile, { onlyIfExpiresAtMatches: fromFile.expiresAt });
    return null;
  }
  return fromFile;
}

export async function deleteTokens(profile: string): Promise<void> {
  try {
    _keyringFactory(profile).deletePassword();
  } catch (err) {
    if (_shouldRefuseWindowsFallback(process.platform, err)) refuseWindowsFallback("delete", err);
    // A missing entry is not an error; the file fallback below still
    // runs so a partial keyring/file divergence is cleaned up. A broken
    // daemon is still refused on unix unless the user opts into
    // plaintext — otherwise `logout` would silently only clear half of
    // a split-brain storage situation.
    if (classifyKeyringError(err) === "broken") {
      if (!plaintextFallbackAllowed()) refuseBrokenKeyring("delete", err);
      warnBackendOnce("delete", err);
    }
  }
  // Windows has no file fallback to clean up — Credential Manager is
  // the single source of truth there.
  if (process.platform === "win32") return;
  await deleteFromFile(profile);
}

// ─── File fallback ───────────────────────────────────────────────────────────
//
// One JSON object keyed by profile. Individual writes are atomic via
// `write-file-atomic` (O_EXCL tmp file with crypto-random suffix, fsync
// tmp fd, rename, fsync parent dir). Read-modify-write cycles are
// serialized by an in-process `async-mutex` so concurrent `saveTokens`
// calls in the same Node process don't clobber each other's profiles via
// a stale-snapshot race.
//
// Cross-process coordination (two `appstrate login` invocations from
// different terminals at the same moment) is intentionally NOT handled:
//   - The only node-land library that ever covered it (`proper-lockfile`)
//     has not shipped a release since 2021-01; no actively maintained
//     alternative exists.
//   - The concrete failure mode without the lock is benign: the later
//     write wins, the "losing" session needs a re-login. No credential
//     corruption, no cross-profile leakage (each profile is its own key).
//   - Mainstream CLIs (`gh`, `aws`, `gcloud`) do not lock their credentials
//     file either. The attack surface is not worth a stale dependency.

interface FileStore {
  [profile: string]: Tokens;
}

/**
 * Serialize in-process read-modify-write cycles on the credentials file.
 * A single `Mutex` shared across every `saveToFile` / `deleteFromFile`
 * call ensures 10 concurrent `Promise.all([saveTokens(...), ...])` in
 * the same process land in the file one at a time. See the top-of-section
 * note for why we don't attempt cross-process locking.
 */
const fileMutex = new Mutex();

/**
 * SSH-style strict-mode check on the parent directory of the credentials
 * file. The `mkdir(..., { mode: 0o700 })` call is a no-op when the dir
 * already exists — so an attacker (or an earlier umask quirk, or a
 * misguided `chmod -R` on `~/.config`) could leave the dir at 0o755 and
 * we'd silently keep using it. World/group-readability of the parent dir
 * is enough to enable symlink-planting and tmp-file racing attacks even
 * though the credentials file itself is 0600.
 *
 * Alternative considered: `chmod(path, 0o700)` post-mkdir. Rejected to
 * stay aligned with the credentials-file strict-mode check (~L306-323
 * REFUSES instead of silently fixing) and SSH's own strict-mode style —
 * silently changing perms on a user's config dir would mask whatever
 * misconfiguration set it wrong, hiding a likely real problem.
 *
 * Skipped on Windows: NTFS doesn't have unix mode bits, and the file
 * fallback is refused on win32 anyway.
 */
async function assertConfigDirSecure(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const st = await stat(path);
  const mode = st.mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(
      `Refusing to use ${path}: insecure directory permissions ${mode.toString(8)} (expected 700).\n` +
        `  A world/group-readable parent directory enables symlink-planting and\n` +
        `  tmp-file racing attacks against credentials.json even though the file\n` +
        `  itself is 0600.\n\n` +
        `  Fixes:\n` +
        `    • chmod 700 "${path}"\n` +
        `    • Or delete the directory and re-run \`appstrate login\`.`,
    );
  }
  // `process.getuid()` is defined on posix only; the typings allow
  // `undefined` so we narrow rather than `!`-assert. Matches the
  // ownership check on the credentials file in `readFileStore`.
  const getuid = process.getuid;
  if (typeof getuid === "function" && st.uid !== getuid.call(process)) {
    throw new Error(
      `Refusing to use ${path}: directory is not owned by the current user (uid ${st.uid}).\n` +
        `  Delete it and re-run \`appstrate login\`.`,
    );
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = dirname(fallbackPath());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Validate AFTER mkdir — mkdir is a no-op when the dir already exists,
  // so a pre-existing 0o755 dir would slip past without this check.
  // Placing the assertion in `withLock` covers all file-fallback ops
  // (save/load/delete) in a single chokepoint.
  await assertConfigDirSecure(dir);
  return fileMutex.runExclusive(fn);
}

async function readFileStore(): Promise<FileStore> {
  const target = fallbackPath();
  try {
    // SSH-style strict-mode check on the credentials file: refuse to
    // parse a credentials store that is group/world-readable or owned
    // by another user. A credentials.json left at 0644 by an earlier
    // buggy version, a tool that chmod'd it unsafely, or a malicious
    // peer who swapped the file to their own ownership on a shared host
    // should not silently yield tokens to the caller. Skipped on Windows
    // where unix mode bits are meaningless (NTFS ACLs — and we refuse
    // the file fallback there anyway).
    if (process.platform !== "win32") {
      const st = await stat(target);
      const mode = st.mode & 0o777;
      if (mode !== 0o600) {
        throw new Error(
          `Refusing to read ${target}: insecure permissions ${mode.toString(8)} (expected 600). ` +
            `Run: chmod 600 "${target}" — or delete it and re-run \`appstrate login\`.`,
        );
      }
      // `process.getuid()` is defined on posix only. The typings allow
      // `undefined` so we narrow rather than `!`-assert.
      const getuid = process.getuid;
      if (typeof getuid === "function" && st.uid !== getuid.call(process)) {
        throw new Error(
          `Refusing to read ${target}: file is not owned by the current user (uid ${st.uid}). ` +
            `Delete it and re-run \`appstrate login\`.`,
        );
      }
    }
    const raw = await readFile(target, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as FileStore;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Atomic overwrite via `write-file-atomic`. It handles:
 *   - O_EXCL tmp file in the same directory with a crypto-random suffix
 *     (closes symlink-planting on shared XDG_CONFIG_HOME)
 *   - `fsync` on the tmp fd before rename
 *   - `rename()` onto the target
 *   - `fsync` on the parent directory (Linux ext4/xfs durability)
 *   - Tmp cleanup on rename failure
 *
 * We don't set `chown` — the default behavior (match the existing
 * target's uid/gid on overwrite, or fall through to the current user on
 * first write) is exactly what we want. The strict-mode + uid check in
 * `readFileStore` already refuses to hand tokens to a foreign-owned file,
 * so the no-op case where the owner matches is the only one we ever
 * write into.
 */
async function writeFileStore(store: FileStore): Promise<void> {
  const target = fallbackPath();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFileAtomic(target, JSON.stringify(store, null, 2), { mode: 0o600 });
}

async function saveToFile(profile: string, tokens: Tokens): Promise<void> {
  await withLock(async () => {
    const store = await readFileStore();
    store[profile] = tokens;
    await writeFileStore(store);
  });
}

async function loadFromFile(profile: string): Promise<Tokens | null> {
  // Reads don't need the in-process mutex: `writeFileStore` is atomic
  // via rename, so a concurrent read sees either the old or the new
  // complete file. We DO still need the parent-dir strict-mode check
  // — `withLock` is the chokepoint for save/delete, but loads bypass
  // it for the lock-skipping reason above. Calling
  // `assertConfigDirSecure` directly here keeps every file-fallback
  // operation (save/load/delete) uniformly guarded against a
  // pre-existing world-readable parent dir.
  //
  // ENOENT on the dir means the user has never logged in via the
  // file fallback — return null silently rather than asserting on a
  // path that doesn't exist.
  const dir = dirname(fallbackPath());
  try {
    await assertConfigDirSecure(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const store = await readFileStore();
  const row = store[profile];
  if (!row) return null;
  if (typeof row.accessToken !== "string") return null;
  if (typeof row.expiresAt !== "number") return null;
  return { accessToken: row.accessToken, expiresAt: row.expiresAt };
}

/**
 * Remove a profile from the file store. Unconditional by default
 * (used by `deleteTokens` / logout — the user's intent is to nuke
 * the row regardless of its current state).
 *
 * Compare-and-swap variant via `opts.onlyIfExpiresAtMatches`: the
 * caller passes the `expiresAt` they read a moment earlier, and the
 * delete only proceeds if the row currently stored still carries
 * that same `expiresAt`. Used by the `loadTokens` expired-token
 * scrub to avoid destroying a fresh token that another process
 * wrote into the store between our read and the delete. The
 * top-of-section doc accepts concurrent-save races as benign
 * (last-write-wins), but the unconditional scrub turns that benign
 * race into the destruction of a valid login — the CAS preserves
 * the benign semantics.
 *
 * The `loadTokens` keyring-path scrub uses the same rationale but
 * with a re-read guard instead of a proper CAS — napi-rs/keyring
 * exposes no atomic test-and-delete primitive, so that branch is
 * best-effort where this one is exact (fileMutex + in-lock re-read
 * serialize same-process racers; cross-process racers are caught
 * because we only ever delete when the stored `expiresAt` matches
 * what the caller saw).
 */
async function deleteFromFile(
  profile: string,
  opts?: { onlyIfExpiresAtMatches?: number },
): Promise<void> {
  await withLock(async () => {
    let store: FileStore;
    try {
      store = await readFileStore();
    } catch {
      return;
    }
    if (!(profile in store)) return;
    if (opts?.onlyIfExpiresAtMatches !== undefined) {
      const current = store[profile];
      if (!current || current.expiresAt !== opts.onlyIfExpiresAtMatches) return;
    }
    delete store[profile];
    if (Object.keys(store).length === 0) {
      await unlink(fallbackPath()).catch(() => {});
      return;
    }
    await writeFileStore(store);
  });
}

function parseTokens(raw: string): Tokens | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as Record<string, unknown>;
    if (typeof row.accessToken !== "string") return null;
    if (typeof row.expiresAt !== "number") return null;
    return { accessToken: row.accessToken, expiresAt: row.expiresAt };
  } catch {
    return null;
  }
}
