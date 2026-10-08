// SPDX-License-Identifier: Apache-2.0

/**
 * Token storage for the CLI.
 *
 * Primary path: OS keyring via `@napi-rs/keyring` (Keychain on macOS,
 * libsecret/DBus on Linux, Credential Manager on Windows). Fallback:
 * `$XDG_CONFIG_HOME/appstrate/credentials.json` with `0600` permissions
 * when no keyring daemon is available (CI runners, stripped containers
 * — confirmed during preflight PF-1 where `@napi-rs/keyring` threw a
 * `PlatformFailure` on a bare Debian slim image). Which throws take
 * that fallback and which are refused is {@link classifyKeyringError}.
 *
 * Tokens are scoped by profile: the keyring entry key is
 * `(appstrate, <profile>)` so profiles share the service name.
 *
 * The CLI stores BOTH a short-lived JWT access token (15 min) AND a
 * long-lived rotating refresh token (30 days) returned by
 * `/api/auth/cli/token`. The access token is presented as
 * `Authorization: Bearer ey...` on every authenticated call; the
 * refresh token is exchanged at the same endpoint (grant_type=
 * refresh_token) to mint a fresh access token without user interaction.
 */

import { Entry } from "@napi-rs/keyring";
import { join, dirname } from "node:path";
import { readFile, unlink, mkdir, stat } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import { Mutex } from "async-mutex";
import { getConfigDir } from "./config.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { logoutRetry } from "./remedy.ts";
import { shellArg } from "./shell.ts";

/**
 * Opt-in escape hatch for environments where the keyring daemon is
 * present but refuses to serve (SSH-attached macOS without a logged-in
 * loginwindow, frozen gnome-keyring, stripped container with a stale
 * libsecret socket). Without this env var set, a `"store-locked"`
 * keyring error is fatal instead of silently writing plaintext tokens
 * to the file fallback. The rationale is symmetric with the Windows refusal:
 * if the user's machine is configured to protect secrets via the OS
 * keyring, a broken backend is a signal, not a reason to quietly
 * downgrade.
 */
function plaintextFallbackAllowed(): boolean {
  return process.env.APPSTRATE_ALLOW_PLAINTEXT_TOKENS === "1";
}

export interface Tokens {
  /**
   * JWT access token. Sent as `Authorization: Bearer <value>` on every
   * authenticated request. When the JWT expires, `api.ts` silently
   * rotates via the refresh token; when the refresh token is revoked,
   * the CLI surfaces a `re-login required` `AuthError` to the command.
   */
  accessToken: string;
  /** Epoch-ms at which the access token expires. */
  expiresAt: number;
  /**
   * Opaque rotating refresh token (32 bytes → base64url, 43 chars).
   * Issued alongside the access token by `/api/auth/cli/token` on
   * device-flow completion.
   */
  refreshToken: string;
  /**
   * Epoch-ms at which the refresh token expires. The CLI never sends an
   * expired refresh token to the server (which would fail with
   * `invalid_grant` anyway) — it clears the tokens and surfaces a
   * re-login message.
   */
  refreshExpiresAt: number;
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
let _keyringFactoryOverridden = false;

export function _setKeyringFactoryForTesting(factory: KeyringFactory | null): void {
  _keyringFactory = factory ?? ((profile) => new Entry(SERVICE_NAME, profile));
  _keyringFactoryOverridden = factory !== null;
}

/**
 * Read side of the seam above, for the fixture's own test only.
 *
 * Unwiring cannot be observed through `_keyringFactory`: passing `null`
 * reinstalls a NEW closure, so the variable is never `null`. Observing it by
 * READING instead reaches `@napi-rs/keyring` for real, which SEGFAULTS on a
 * daemon-less runner — a native crash no `catch` can see.
 */
export function _isKeyringFactoryOverriddenForTesting(): boolean {
  return _keyringFactoryOverridden;
}

function fallbackPath(): string {
  return join(getConfigDir(), "credentials.json");
}

/**
 * Display prefix of `keyring-core`'s `PlatformFailure` variant — the
 * store machinery is not functional on this host at all: no DBus
 * session bus, no libsecret, stripped container, bare CI runner.
 * See {@link classifyKeyringError}.
 */
export const PLATFORM_FAILURE_MARKER = "Platform failure: ";

/** De-dupe stderr output across calls within the same process. */
let _backendWarningEmitted = false;

/**
 * Sort a keyring throw into the only two outcomes that change what we do.
 *
 * `@napi-rs/keyring` 2.x reports errors as plain `Error`s, so the Display
 * prefix IS the discriminator; `test/keyring-error-markers.test.ts` pins it
 * against the shipped native binary, so a rewording is a red test.
 *
 * `store-unavailable` (`PlatformFailure`): no keyring on this host, nothing to
 * downgrade FROM — the 0600 file store is the only option. Everything else is
 * `store-locked`: the store answered and refused us, so a plaintext write
 * would be a real downgrade. Unknown wording lands on the conservative side.
 *
 * There is no "entry missing" class: 2.x returns `null`/`false` for that.
 */
function classifyKeyringError(err: unknown): "store-unavailable" | "store-locked" {
  return getErrorMessage(err).includes(PLATFORM_FAILURE_MARKER)
    ? "store-unavailable"
    : "store-locked";
}

/**
 * On Windows, refuse the file fallback entirely: NTFS ACLs do NOT
 * enforce Unix 0600 permissions, so `fs.chmod(0o600)` is a no-op. A
 * plaintext credentials file dropped under `%APPDATA%\appstrate\` is
 * readable by every local user on the machine — bearer token = full
 * account takeover. Credential Manager is the only acceptable store on
 * Windows; if it's down, we fail loudly rather than silently fall back
 * to disk. DPAPI-based encryption would fix this but is out of scope
 * for v1 (tracked as a follow-up).
 *
 * Every throw from `@napi-rs/keyring` 2.x means the store did not serve
 * the operation (a missing entry is a `null`/`false` return, not a
 * throw), so on Windows the refusal is unconditional — there is no
 * error class that would legitimately reach the file store here.
 */
function refuseWindowsFallback(op: "read" | "write" | "delete", err: unknown): never {
  const cause = getErrorMessage(err);
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

/** Per-OS unlock instructions, shared by every keyring refusal message. */
const KEYRING_UNLOCK_HINT =
  `    • macOS: run the CLI from a Terminal attached to a logged-in\n` +
  `      GUI session (Keychain needs loginwindow). Under SSH, run\n` +
  `      \`security unlock-keychain\` first or re-attach via tmux from\n` +
  `      a GUI terminal.\n` +
  `    • Linux: ensure gnome-keyring / kwallet is running and unlocked\n` +
  `      (check with \`secret-tool store …\`).`;

function refuseBrokenKeyring(op: "read" | "write", err: unknown): never {
  const cause = getErrorMessage(err);
  throw new Error(
    `Cannot ${op} Appstrate credentials: the OS keyring is installed but not serving.\n` +
      `  Cause: ${cause}\n` +
      `  Refusing to fall back to the plaintext file store because your\n` +
      `  machine is configured to protect secrets via the keyring — a\n` +
      `  plaintext credentials.json would be a silent downgrade.\n\n` +
      `  Fixes (pick one):\n` +
      KEYRING_UNLOCK_HINT +
      `\n` +
      `    • Explicitly accept plaintext storage with:\n` +
      `        APPSTRATE_ALLOW_PLAINTEXT_TOKENS=1 appstrate login\n` +
      `      Only do this if you understand the tokens will be written\n` +
      `      to ~/.config/appstrate/credentials.json (mode 0600).`,
  );
}

function warnBackendOnce(op: "read" | "write" | "delete", err: unknown): void {
  if (_backendWarningEmitted) return;
  _backendWarningEmitted = true;
  const outcome =
    op === "delete"
      ? "the credentials file was cleared; a copy may remain in the keyring"
      : "falling back to ~/.config/appstrate/credentials.json (0600)";
  process.stderr.write(
    `[appstrate] OS keyring ${op} failed (${getErrorMessage(err)}) — ${outcome}. ` +
      `If this was unexpected, fix the keyring backend to restore secure storage.\n`,
  );
}

export async function saveTokens(profile: string, tokens: Tokens): Promise<void> {
  const payload = JSON.stringify(tokens);
  try {
    _keyringFactory(profile).setPassword(payload);
    return;
  } catch (err) {
    if (process.platform === "win32") refuseWindowsFallback("write", err);
    // The write path is the only one that can DOWNGRADE storage: it is
    // where a plaintext file would come into existence. `store-locked`
    // means the host does protect secrets, so refuse unless the
    // operator opted in; `store-unavailable` means there is nothing to
    // downgrade from and the 0600 file is the documented fallback.
    if (classifyKeyringError(err) === "store-locked") {
      if (!plaintextFallbackAllowed()) refuseBrokenKeyring("write", err);
      warnBackendOnce("write", err);
    }
  }
  await saveToFile(profile, tokens);
}

// Absent once the refresh token expires (an expired access token alone is rotated).
// Reads never delete: outside the credentials lock, a write could roll back a peer's pair.
function isExpired(tokens: Tokens): boolean {
  return tokens.refreshExpiresAt <= Date.now();
}

export async function loadTokens(profile: string): Promise<Tokens | null> {
  try {
    const raw = _keyringFactory(profile).getPassword();
    if (typeof raw === "string" && raw.length > 0) {
      const parsed = parseTokens(raw);
      if (parsed && isExpired(parsed)) return null;
      return parsed;
    }
  } catch (err) {
    if (process.platform === "win32") refuseWindowsFallback("read", err);
    // A host with no working store (`store-unavailable`) is the
    // expected fallback trigger — the credentials only ever lived in
    // the file. A locked store is refused on unix unless the user opts
    // into plaintext explicitly, otherwise we'd silently read from a
    // plaintext file the user never consented to populate.
    if (classifyKeyringError(err) === "store-locked") {
      if (!plaintextFallbackAllowed()) refuseBrokenKeyring("read", err);
      warnBackendOnce("read", err);
    }
  }
  // Windows never reaches here: the guard above either succeeded on
  // Credential Manager or threw via `refuseWindowsFallback`.
  if (process.platform === "win32") return null;
  const fromFile = await loadFromFile(profile);
  if (fromFile && isExpired(fromFile)) return null;
  return fromFile;
}

/**
 * Remove a profile's tokens from BOTH stores.
 *
 * Deletion never withholds the local cleanup: leaving a live plaintext
 * refresh token in `credentials.json` after the user ran `logout` is
 * the outcome we are protecting against (issue #1321). So the file
 * store is always cleared first, and only then is a keyring failure
 * reported — loudly, because a copy of the credential may survive
 * there, unless the operator opted into plaintext storage and so never
 * had a keyring entry to remove.
 */
export async function deleteTokens(profile: string): Promise<void> {
  let keyringError: unknown;
  try {
    _keyringFactory(profile).deletePassword();
  } catch (err) {
    keyringError = err;
  }
  // Windows has no file fallback to clean up — Credential Manager is
  // the single source of truth there.
  if (process.platform !== "win32") await deleteFromFile(profile);
  if (keyringError === undefined) return;
  if (process.platform === "win32") refuseWindowsFallback("delete", keyringError);
  // A host with no working store never held a keyring entry for this
  // profile — the file store we just cleared was the only copy.
  if (classifyKeyringError(keyringError) === "store-unavailable") return;
  // An operator who opted into plaintext storage never had a keyring entry to
  // remove, so a locked store is not a failure for them.
  if (plaintextFallbackAllowed()) {
    warnBackendOnce("delete", keyringError);
    return;
  }
  throw new Error(
    `Signed out of profile "${profile}" locally, but the OS keyring entry could not be removed.\n` +
      `  Cause: ${getErrorMessage(keyringError)}\n` +
      `  The credentials file was cleared; a copy of the token may remain in\n` +
      `  the keyring until the store is reachable again.\n\n` +
      `  Fixes:\n` +
      KEYRING_UNLOCK_HINT +
      `\n      Then: ${logoutRetry(profile)}\n` +
      `    • Or delete the "${SERVICE_NAME}" entry for "${profile}" with your\n` +
      `      platform's credential manager.\n` +
      `    • Or accept that the keyring copy survives until the store is\n` +
      `      reachable again:\n` +
      `        APPSTRATE_ALLOW_PLAINTEXT_TOKENS=1 appstrate logout --profile ${shellArg(profile)}`,
  );
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
// Across processes, every writer holds `withCredentialsLock` (`api.ts`); reads
// take no lock, and atomic renames give them a whole file.

interface FileStore {
  [profile: string]: Tokens;
}

/**
 * Serialize in-process read-modify-write cycles on the credentials file.
 * A single `Mutex` shared across every `saveToFile` / `deleteFromFile`
 * call ensures 10 concurrent `Promise.all([saveTokens(...), ...])` in
 * the same process land in the file one at a time; see the top-of-section note.
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
  if (typeof row.refreshToken !== "string") return null;
  if (typeof row.refreshExpiresAt !== "number") return null;
  return {
    accessToken: row.accessToken,
    expiresAt: row.expiresAt,
    refreshToken: row.refreshToken,
    refreshExpiresAt: row.refreshExpiresAt,
  };
}

/** Remove a profile from the file store, whatever it holds. */
async function deleteFromFile(profile: string): Promise<void> {
  await withLock(async () => {
    let store: FileStore;
    try {
      store = await readFileStore();
    } catch {
      return;
    }
    if (!(profile in store)) return;
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
    if (typeof row.refreshToken !== "string") return null;
    if (typeof row.refreshExpiresAt !== "number") return null;
    return {
      accessToken: row.accessToken,
      expiresAt: row.expiresAt,
      refreshToken: row.refreshToken,
      refreshExpiresAt: row.refreshExpiresAt,
    };
  } catch {
    return null;
  }
}
