// SPDX-License-Identifier: Apache-2.0

/**
 * CLI config — TOML-backed multi-profile store.
 *
 * File: `$XDG_CONFIG_HOME/appstrate/config.toml` (or `~/.config/appstrate/`
 * when `XDG_CONFIG_HOME` is unset). One `[profile.<name>]` section per
 * profile holds the non-secret state (`instance`, `user_id`, `email`,
 * `org_id`). Access tokens live in the OS keyring, not here — see
 * `./keyring.ts`.
 *
 * Profile resolution order (same convention as AWS / gcloud / doctl):
 *   1. `--profile <name>` CLI flag  (caller passes explicitly)
 *   2. `APPSTRATE_PROFILE` env var
 *   3. `defaultProfile` key in the config file
 *   4. Literal `"default"`
 *
 * Writes are atomic: we write to a tmp file in the same directory and
 * `rename()` it over the target. Partial writes from a Ctrl-C mid-save
 * cannot leave `config.toml` in a half-parsed state.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export interface Profile {
  instance: string;
  userId: string;
  email: string;
  orgId?: string;
  applicationId?: string;
  /**
   * Sticky default connection profile UUID — applied to every
   * credential-proxy call as `X-Connection-Profile-Id` unless the user
   * passes `--connection-profile` on the command line. Set via
   * `appstrate connections profile switch`.
   */
  connectionProfileId?: string;
}

export interface Config {
  defaultProfile: string;
  profiles: Record<string, Profile>;
}

/** Fresh empty config. Always return a NEW object here — callers mutate
 * `profiles` in-place before calling `writeConfig`, so a shared module-
 * level literal would accumulate writes across calls and silently
 * pollute the next `readConfig()` (subtle bug: a `{ ...EMPTY }` spread
 * is shallow, `profiles` stays the same reference). */
function emptyConfig(): Config {
  return { defaultProfile: "default", profiles: {} };
}

/**
 * Resolve the directory holding `config.toml`, creating it on first
 * write. Tests point `XDG_CONFIG_HOME` at a per-test tmpdir — no
 * dedicated test backdoor needed.
 */
export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "appstrate");
  return join(homedir(), ".config", "appstrate");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.toml");
}

/**
 * Resolve which profile to act on. Callers may already have parsed a
 * `--profile` value off the command line — pass it as `explicit` and it
 * takes precedence over every other source. Undefined explicit delegates
 * to the env → config file → `"default"` cascade.
 */
export function resolveProfileName(explicit: string | undefined, config: Config): string {
  if (explicit && explicit.length > 0) return explicit;
  const envVar = process.env.APPSTRATE_PROFILE;
  if (envVar && envVar.length > 0) return envVar;
  if (config.defaultProfile && config.defaultProfile.length > 0) return config.defaultProfile;
  return "default";
}

/** Parse `config.toml`, returning an empty config when the file is missing. */
export async function readConfig(): Promise<Config> {
  const path = getConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
    throw err;
  }
  const parsed = parseToml(raw) as Record<string, unknown>;
  const defaultProfile =
    typeof parsed.defaultProfile === "string" ? parsed.defaultProfile : "default";
  const profilesRaw = (parsed.profile ?? {}) as Record<string, unknown>;
  const profiles: Record<string, Profile> = {};
  for (const [name, value] of Object.entries(profilesRaw)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    // Every stored profile must at least have an instance + userId +
    // email — a row missing these is a corrupt write and we ignore it
    // rather than crash the CLI on every invocation.
    if (
      typeof row.instance !== "string" ||
      typeof row.userId !== "string" ||
      typeof row.email !== "string"
    ) {
      continue;
    }
    profiles[name] = {
      instance: row.instance,
      userId: row.userId,
      email: row.email,
      orgId: typeof row.orgId === "string" ? row.orgId : undefined,
      applicationId: typeof row.applicationId === "string" ? row.applicationId : undefined,
      connectionProfileId:
        typeof row.connectionProfileId === "string" ? row.connectionProfileId : undefined,
    };
  }
  return { defaultProfile, profiles };
}

/** Overwrite the config file atomically (tmp + rename). */
export async function writeConfig(config: Config): Promise<void> {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = getConfigPath();
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const payload = stringifyToml({
    defaultProfile: config.defaultProfile,
    profile: config.profiles,
  });
  await writeFile(tmp, payload, { mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Fetch a single profile by name, returning `null` if it is absent. The
 * config file itself is read on every call — writes are rare enough that
 * a cache would complicate invalidation for no measurable win.
 */
export async function getProfile(name: string): Promise<Profile | null> {
  const config = await readConfig();
  return config.profiles[name] ?? null;
}

/**
 * Merge a partial update into an existing profile. Used by the login
 * org→app cascade and the `org switch` / `app switch` commands to rewrite
 * a single field (`orgId`, `applicationId`) without re-reading the whole profile
 * at each call site.
 *
 * `undefined` in the patch means "clear the key" — strip it before write
 * so the key doesn't round-trip as a bare TOML entry.
 */
export async function updateProfile(name: string, patch: Partial<Profile>): Promise<void> {
  const config = await readConfig();
  const existing = config.profiles[name];
  if (!existing) {
    throw new Error(`Profile "${name}" missing from config — internal invariant broken.`);
  }
  const next: Profile = { ...existing, ...patch };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (next as unknown as Record<string, unknown>)[k];
  }
  config.profiles[name] = next;
  await writeConfig(config);
}

/**
 * Resolve the active profile in one call — wraps the
 * `resolveProfileName` → `readConfig` → lookup dance every command does
 * at entry. Returns `profile: undefined` if the resolved name has no
 * matching section in `config.toml`; pair with `requireLoggedIn` to
 * hard-exit on that path.
 */
export async function resolveActiveProfile(
  explicit: string | undefined,
): Promise<{ profileName: string; profile: Profile | undefined }> {
  const config = await readConfig();
  const profileName = resolveProfileName(explicit, config);
  return { profileName, profile: config.profiles[profileName] };
}

/**
 * Narrow `profile` from `Profile | undefined` to `Profile`, hard-exiting
 * with an actionable hint when the resolved profile has no config entry.
 * Used by every `appstrate org …` / `appstrate app …` subcommand —
 * centralized so the phrasing stays in sync across the two command
 * families.
 */
export function requireLoggedIn(
  profileName: string,
  profile: Profile | undefined,
): asserts profile is Profile {
  if (!profile) {
    process.stderr.write(
      `Profile "${profileName}" not configured. Run: appstrate login --profile ${profileName}\n`,
    );
    process.exit(1);
  }
}

export async function setProfile(name: string, profile: Profile): Promise<void> {
  const config = await readConfig();
  config.profiles[name] = profile;
  // Point `defaultProfile` at this one if the current pointer is
  // missing or references a profile that doesn't exist yet. Typical
  // path: first write to a fresh config (`defaultProfile = "default"`,
  // profiles = {}) → this becomes the default. Subsequent writes
  // leave the existing valid default alone.
  if (!config.defaultProfile || !config.profiles[config.defaultProfile]) {
    config.defaultProfile = name;
  }
  await writeConfig(config);
}

export async function deleteProfile(name: string): Promise<boolean> {
  const config = await readConfig();
  if (!(name in config.profiles)) return false;
  delete config.profiles[name];
  // If we just removed the active default, fall back to any remaining
  // profile or the literal `"default"` — the next write will materialize
  // the change. Leaving a stale `defaultProfile` pointer that references
  // a non-existent profile would force every subsequent command to fall
  // through to `"default"` anyway, but we clean it up to keep the file
  // honest.
  if (config.defaultProfile === name) {
    const remaining = Object.keys(config.profiles);
    config.defaultProfile = remaining[0] ?? "default";
  }
  await writeConfig(config);
  return true;
}

export async function listProfiles(): Promise<string[]> {
  const config = await readConfig();
  return Object.keys(config.profiles).sort();
}
