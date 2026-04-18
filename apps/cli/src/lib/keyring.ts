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
import { readFile, writeFile, unlink, mkdir, chmod } from "node:fs/promises";
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
// One JSON object keyed by profile. Rewriting the full file on every
// save is fine — this path is exercised only when the keyring is
// unavailable and writes happen at most once per login.

interface FileStore {
  [profile: string]: Tokens;
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

async function writeFileStore(store: FileStore): Promise<void> {
  const dir = dirname(fallbackPath());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(fallbackPath(), JSON.stringify(store, null, 2), { mode: 0o600 });
  // Re-chmod defensively — umask on some hosts lets writeFile create
  // files with wider permissions despite the `mode` option.
  await chmod(fallbackPath(), 0o600).catch(() => {});
}

async function saveToFile(profile: string, tokens: Tokens): Promise<void> {
  const store = await readFileStore();
  store[profile] = tokens;
  await writeFileStore(store);
}

async function loadFromFile(profile: string): Promise<Tokens | null> {
  const store = await readFileStore();
  const row = store[profile];
  if (!row) return null;
  if (typeof row.accessToken !== "string") return null;
  if (typeof row.expiresAt !== "number") return null;
  return { accessToken: row.accessToken, expiresAt: row.expiresAt };
}

async function deleteFromFile(profile: string): Promise<void> {
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
