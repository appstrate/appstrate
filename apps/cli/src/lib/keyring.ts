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
import { readFile, unlink, mkdir, rename, open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
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
 */
const MISSING_BACKEND_MARKERS = [
  "Platform secure storage failure",
  "No storage",
  "No matching entry",
];

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
    // Entry-missing is a read-path concept — on write, any failure means
    // the backend cannot accept the payload. A "broken" daemon (installed
    // but misbehaving) is refused unless the user opts into plaintext
    // explicitly; "missing-backend" keeps the silent fallback (CI, bare
    // container — no keyring expected).
    if (classifyKeyringError(err) === "broken") {
      if (!plaintextFallbackAllowed()) refuseBrokenKeyring("write", err);
      warnBackendOnce("write", err);
    }
  }
  await saveToFile(profile, tokens);
}

export async function loadTokens(profile: string): Promise<Tokens | null> {
  try {
    const raw = _keyringFactory(profile).getPassword();
    if (typeof raw === "string" && raw.length > 0) return parseTokens(raw);
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
  return loadFromFile(profile);
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
// One JSON object keyed by profile. Writes are atomic (tmp + rename) and
// serialized by a PID-aware advisory lock so two concurrent `appstrate
// login` invocations targeting different profiles don't clobber each
// other's entries via the read-modify-write cycle.

interface FileStore {
  [profile: string]: Tokens;
}

function lockPath(): string {
  return `${fallbackPath()}.lock`;
}

/**
 * Serialize read-modify-write cycles on the credentials file.
 *
 * Uses `open(..., "wx")` (O_EXCL + O_CREAT + O_WRONLY) as a primitive
 * advisory lock and stores the holder's PID inside so we can detect
 * crashed-and-left-over locks from previous CLI runs. 5-second overall
 * deadline — credential writes are single-digit milliseconds; anything
 * longer means a crashed peer or a truly pathological filesystem.
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const path = lockPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const DEADLINE_MS = 5_000;
  const POLL_MS = 50;
  const start = Date.now();
  let staleRecoveryDone = false;

  while (true) {
    try {
      const fd = await open(path, "wx", 0o600);
      try {
        await fd.writeFile(`${process.pid}\n`);
      } finally {
        await fd.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      // Lock held — check if the holder is still alive. A single stale
      // recovery per `withLock` call avoids spinning on a lock file that
      // a concurrent peer keeps recreating.
      if (!staleRecoveryDone) {
        staleRecoveryDone = true;
        try {
          const heldBy = parseInt((await readFile(path, "utf-8")).trim(), 10);
          if (heldBy && !processIsAlive(heldBy)) {
            await unlink(path).catch(() => {});
            continue;
          }
        } catch {
          // Lock vanished between EEXIST and readFile — next iteration
          // will race cleanly for it.
          continue;
        }
      }

      if (Date.now() - start > DEADLINE_MS) {
        throw new Error(
          `Timed out acquiring credentials lock ${path}. ` +
            `If no other appstrate command is running, remove this file manually.`,
        );
      }
      await delay(POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => {});
  }
}

function processIsAlive(pid: number): boolean {
  try {
    // `kill(pid, 0)` is the POSIX "process exists" probe — no signal
    // delivered, throws ESRCH if the PID is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readFileStore(): Promise<FileStore> {
  try {
    const raw = await readFile(fallbackPath(), "utf-8");
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
 * Atomic overwrite — tmp file in the same directory, `rename()` over
 * the target. Matches `lib/config.ts::writeConfig` so the same crash /
 * Ctrl-C semantics apply to both files: post-crash state is always
 * either the pre-write contents or the full post-write contents, never
 * a truncated or partially-written mix.
 *
 * Durability: we `fsync` both the tmp file and its parent directory
 * before the rename, so a post-rename power loss cannot leave a
 * directory entry pointing at a zero-length inode. Credential writes
 * happen once per login and complete in single-digit ms — the fsync
 * cost is irrelevant in exchange for crash-consistency.
 */
async function writeFileStore(store: FileStore): Promise<void> {
  const target = fallbackPath();
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const tmpFd = await open(tmp, "w", 0o600);
  try {
    await tmpFd.writeFile(JSON.stringify(store, null, 2));
    await tmpFd.sync();
  } finally {
    await tmpFd.close();
  }
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  // Dir fsync makes the rename itself durable — on Linux ext4/xfs, the
  // directory entry update is only guaranteed on-disk after the parent
  // is fsync'd. Best-effort on platforms that don't support dir fds
  // (Windows), where we don't ship this fallback anyway.
  try {
    const dirFd = await open(parent, "r");
    try {
      await dirFd.sync();
    } finally {
      await dirFd.close();
    }
  } catch {
    // Non-fatal — the data is already on disk via the tmp fsync. If the
    // directory fsync is unavailable on this platform / filesystem, the
    // worst post-crash outcome is the rename being rolled back and the
    // previous credentials file being seen, which is recoverable by
    // re-running `appstrate login`.
  }
}

async function saveToFile(profile: string, tokens: Tokens): Promise<void> {
  await withLock(async () => {
    const store = await readFileStore();
    store[profile] = tokens;
    await writeFileStore(store);
  });
}

async function loadFromFile(profile: string): Promise<Tokens | null> {
  // Reads don't need the lock: `writeFileStore` is atomic via rename,
  // so a concurrent read sees either the old or the new complete file.
  const store = await readFileStore();
  const row = store[profile];
  if (!row) return null;
  if (typeof row.accessToken !== "string") return null;
  if (typeof row.expiresAt !== "number") return null;
  return { accessToken: row.accessToken, expiresAt: row.expiresAt };
}

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
    return { accessToken: row.accessToken, expiresAt: row.expiresAt };
  } catch {
    return null;
  }
}
