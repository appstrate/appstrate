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
import { readFile, writeFile, unlink, mkdir, rename, open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getConfigDir } from "./config.ts";

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
    // Entry-missing is a read-path concept — on write, any failure means
    // the backend cannot accept the payload. Only missing-backend is
    // silent; anything else warns once.
    if (classifyKeyringError(err) === "broken") warnBackendOnce("write", err);
  }
  await saveToFile(profile, tokens);
}

export async function loadTokens(profile: string): Promise<Tokens | null> {
  try {
    const raw = _keyringFactory(profile).getPassword();
    if (typeof raw === "string" && raw.length > 0) return parseTokens(raw);
  } catch (err) {
    // "No matching entry" on read is normal — the user simply hasn't
    // stored credentials for this profile yet. Missing-backend is the
    // expected fallback trigger. Anything else is worth a warning.
    const kind = classifyKeyringError(err);
    if (kind === "broken") warnBackendOnce("read", err);
  }
  return loadFromFile(profile);
}

export async function deleteTokens(profile: string): Promise<void> {
  try {
    _keyringFactory(profile).deletePassword();
  } catch (err) {
    // A missing entry is not an error; the file fallback below still
    // runs so a partial keyring/file divergence is cleaned up. Only
    // warn on genuinely broken backends.
    if (classifyKeyringError(err) === "broken") warnBackendOnce("delete", err);
  }
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
 */
async function writeFileStore(store: FileStore): Promise<void> {
  const target = fallbackPath();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
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
