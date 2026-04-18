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

export async function saveTokens(profile: string, tokens: Tokens): Promise<void> {
  const payload = JSON.stringify(tokens);
  try {
    _keyringFactory(profile).setPassword(payload);
    return;
  } catch {
    // Keyring backend unavailable → file fallback.
  }
  await saveToFile(profile, tokens);
}

export async function loadTokens(profile: string): Promise<Tokens | null> {
  try {
    const raw = _keyringFactory(profile).getPassword();
    if (typeof raw === "string" && raw.length > 0) return parseTokens(raw);
  } catch {
    // Fall through to file.
  }
  return loadFromFile(profile);
}

export async function deleteTokens(profile: string): Promise<void> {
  try {
    _keyringFactory(profile).deletePassword();
  } catch {
    // A missing entry is not an error; the file fallback below still
    // runs so a partial keyring/file divergence is cleaned up.
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
